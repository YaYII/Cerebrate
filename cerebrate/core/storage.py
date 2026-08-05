"""存储层 - ChromaDB 向量存储（纯向量 + SQLite busy 自动重试 + 并发控制）"""
import logging as _logging
import os as _chroma_os
import threading
import time as _time
from pathlib import Path
from typing import Optional

_chroma_logger = _logging.getLogger(__name__)


def _retry_busy(op, max_retries=5, delay=0.2):
    """SQLite/ChromaDB busy -> auto retry with exponential backoff."""
    for attempt in range(max_retries):
        try:
            return op()
        except Exception as e:
            msg = str(e).lower()
            if ('database is locked' in msg or
                'sqlite_busy' in msg or
                    'busy' in str(type(e).__name__).lower()):
                if attempt < max_retries - 1:
                    _time.sleep(delay * (1.5 ** attempt))
                    continue
            raise
    return op()


class _CerebrateEmbeddingFunction:
    """ChromaDB custom embedding function bridging EmbeddingEngine"""

    def __init__(self, engine):
        self._engine = engine

    def __call__(self, input: list[str]) -> list[list[float]]:
        return self._engine.encode(input)

    def name(self) -> str:
        return f"cerebrate-{self._engine.mode}-{self._engine.dimension}"


class ChromaStore:
    """Vector storage wrapper managing a single ChromaDB collection.

    Concurrency: _db_semaphore limits concurrent DB operations to prevent
    SQLite connection exhaustion under ThreadingHTTPServer load.
    """

    _db_semaphore: Optional[threading.BoundedSemaphore] = None
    _sem_lock = threading.Lock()

    @classmethod
    def _semaphore(cls) -> threading.BoundedSemaphore:
        """惰性初始化 DB 并发信号量（值来自 config.db_semaphore，可配置调大）。"""
        if cls._db_semaphore is None:
            with cls._sem_lock:
                if cls._db_semaphore is None:
                    from cerebrate.config import config
                    cls._db_semaphore = threading.BoundedSemaphore(config.db_semaphore)
        return cls._db_semaphore

    def __init__(self, persist_dir: Path, collection_name: str,
                 embedding_engine=None):
        self.persist_dir = persist_dir
        self.base_collection_name = collection_name
        self._engine = embedding_engine
        suffix = self._engine.mode if self._engine else "default"
        self.collection_name = f"{collection_name}_{suffix}"
        self._client = None
        self._collection = None
        self._write_lock = threading.Lock()
        self._init()

    @property
    def embedding_mode(self) -> str:
        return self._engine.mode if self._engine else "unknown"

    def _init(self):
        import chromadb
        _chroma_os.makedirs(self.persist_dir, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=str(self.persist_dir),
            settings=chromadb.Settings(anonymized_telemetry=False),
        )

        embedding_fn = _CerebrateEmbeddingFunction(
            self._engine) if self._engine else None

        try:
            self._collection = self._client.get_collection(
                name=self.collection_name,
                embedding_function=embedding_fn,
            )
        except ValueError:
            self._collection = self._client.create_collection(
                name=self.collection_name,
                embedding_function=embedding_fn,
                metadata={"hnsw:space": "cosine"},
            )
        except Exception:
            _chroma_logger.warning(
                "Collection %s embedding function mismatch, recreating...",
                self.collection_name,
            )
            try:
                self._client.delete_collection(name=self.collection_name)
            except Exception:
                pass
            self._collection = self._client.create_collection(
                name=self.collection_name,
                embedding_function=embedding_fn,
                metadata={"hnsw:space": "cosine"},
            )

    # ==================== Write ====================

    def add(self, doc_id: str, text: str, metadata: dict,
            embedding: Optional[list[float]] = None) -> str:
        embeddings = None
        if embedding:
            embeddings = [embedding]

        def _add():
            with ChromaStore._semaphore(), self._write_lock:
                self._collection.add(
                    ids=[doc_id],
                    documents=[text],
                    metadatas=[metadata],
                    embeddings=embeddings,
                )
            return doc_id
        return _retry_busy(_add)

    def upsert(self, doc_id: str, text: str, metadata: dict,
               embedding: Optional[list[float]] = None):
        embeddings = None
        if embedding:
            embeddings = [embedding]

        def _upsert():
            with ChromaStore._semaphore(), self._write_lock:
                self._collection.upsert(
                    ids=[doc_id],
                    documents=[text],
                    metadatas=[metadata],
                    embeddings=embeddings,
                )
        _retry_busy(_upsert)

    # ==================== Query ====================

    def search(self, query: str, top_k: int = 10,
               where: Optional[dict] = None,
               query_embedding: Optional[list[float]] = None) -> list[dict]:
        def _search():
            with ChromaStore._semaphore():
                if query_embedding:
                    results = self._collection.query(
                        query_embeddings=[query_embedding],
                        n_results=top_k, where=where,
                        include=["metadatas", "documents",
                                 "distances", "embeddings"],
                    )
                elif self._engine:
                    results = self._collection.query(
                        query_embeddings=[self._engine.encode_query(query)],
                        n_results=top_k, where=where,
                        include=["metadatas", "documents",
                                 "distances", "embeddings"],
                    )
                else:
                    results = self._collection.query(
                        query_texts=[query], n_results=top_k, where=where,
                        include=["metadatas", "documents",
                                 "distances", "embeddings"],
                    )
                items = []
                ids_list = results.get("ids")
                if ids_list and ids_list[0]:
                    metas_list = results.get("metadatas")
                    docs_list = results.get("documents")
                    dists_list = results.get("distances")
                    embs_list = results.get("embeddings")
                    has_meta = metas_list is not None and len(metas_list) > 0
                    has_docs = docs_list is not None and len(docs_list) > 0
                    has_dists = dists_list is not None and len(dists_list) > 0
                    has_embs = embs_list is not None and len(embs_list) > 0
                    for i, mid in enumerate(ids_list[0]):
                        meta = metas_list[0][i] if has_meta else {}
                        dist = dists_list[0][i] if has_dists else 0
                        doc = docs_list[0][i] if has_docs else ""
                        emb = embs_list[0][i] if has_embs else None
                        items.append({
                            "id": mid, "metadata": meta, "document": doc,
                            "distance": dist, "embedding": emb,
                        })
                return items
        return _retry_busy(_search)

    # ==================== Read ====================

    def get(self, doc_id: str) -> Optional[dict]:
        def _get():
            with ChromaStore._semaphore():
                results = self._collection.get(
                    ids=[doc_id],
                    include=["metadatas", "documents", "embeddings"],
                )
                ids_list = results.get("ids") or []
                if ids_list:
                    meta = results["metadatas"][0] if results.get(
                        "metadatas") else {}
                    doc = results["documents"][0] if results.get(
                        "documents") else ""
                    emb = None
                    embs = results.get("embeddings")
                    if embs is not None and len(embs) > 0:
                        emb = embs[0]
                    return {"id": doc_id, "metadata": meta, "document": doc, "embedding": emb}
                return None
        return _retry_busy(_get)

    def get_all_ids(self) -> list[str]:
        def _get_ids():
            with ChromaStore._semaphore():
                results = self._collection.get(include=[])
                ids_list = results.get("ids") or []
                return ids_list
        return _retry_busy(_get_ids)

    # ==================== Delete ====================

    def delete(self, doc_id: str):
        def _del():
            with ChromaStore._semaphore(), self._write_lock:
                self._collection.delete(ids=[doc_id])
        _retry_busy(_del)

    # ==================== Stats ====================

    def count(self) -> int:
        def _count():
            with ChromaStore._semaphore():
                return self._collection.count()
        return _retry_busy(_count)

    def get_all_metadata(self, where: Optional[dict] = None,
                         limit: int = 1000) -> list[dict]:
        """批量读取元数据，受 _db_semaphore 和 _retry_busy 保护"""
        def _get():
            with ChromaStore._semaphore():
                results = self._collection.get(
                    where=where, include=["metadatas"], limit=limit,
                )
                metadatas = results.get("metadatas") or []
                return [m for m in metadatas if m is not None]
        return _retry_busy(_get)

    def get_items_by_where(self, where: dict, limit: int = 100) -> list[dict]:
        """按元数据条件搜索完整条目（含文档文本），不进行向量搜索

        Args:
            where: ChromaDB 元数据过滤条件，如 {"doc_group_id": "abc123"}
            limit: 最大返回数

        Returns:
            [{"id": ..., "metadata": ..., "document": ..., "embedding": ...}, ...]
        """
        def _get():
            with ChromaStore._semaphore():
                results = self._collection.get(
                    where=where,
                    include=["metadatas", "documents", "embeddings"],
                    limit=limit,
                )
                ids = results.get("ids") or []
                metas = results.get("metadatas") or []
                docs = results.get("documents") or []
                embs = results.get("embeddings")
                items = []
                for i, mid in enumerate(ids):
                    meta = metas[i] if i < len(metas) and metas[i] else {}
                    doc = docs[i] if i < len(docs) and docs[i] else ""
                    emb = embs[i] if embs is not None and i < len(embs) else None
                    items.append({"id": mid, "metadata": meta, "document": doc, "embedding": emb})
                return items
        return _retry_busy(_get)

    def get_collection(self):
        return self._collection

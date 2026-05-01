"""存储层 — ChromaDB 向量存储 + 原子文件操作"""

# ==================== 原子文件操作 ====================

import json as _json
import os as _os
import tempfile as _tempfile
import time as _time
from pathlib import Path
from typing import Optional


def atomic_write_json(path: Path, data: dict, indent: int = 2) -> None:
    """原子写入 JSON 文件: 写临时文件 → fsync → os.replace"""
    tmp_fd, tmp_path = _tempfile.mkstemp(
        suffix=".tmp", prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with _os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            _json.dump(data, f, ensure_ascii=False, indent=indent)
            f.flush()
            _os.fsync(f.fileno())
    except Exception:
        _os.unlink(tmp_path)
        raise
    _os.replace(tmp_path, path)


class FileLock:
    """基于 O_CREAT | O_EXCL 的文件 advisory lock"""

    def __init__(self, lock_path: Path, timeout: float = 5.0):
        self.lock_path = lock_path
        self.timeout = timeout
        self._fd: Optional[int] = None

    def __enter__(self):
        deadline = _time.time() + self.timeout
        while True:
            try:
                self._fd = _os.open(
                    str(self.lock_path),
                    _os.O_CREAT | _os.O_EXCL | _os.O_RDWR,
                )
                return self
            except FileExistsError:
                if _time.time() > deadline:
                    raise TimeoutError(
                        f"无法在 {self.timeout}s 内获取锁: {self.lock_path}"
                    )
                _time.sleep(0.05)

    def __exit__(self, *args):
        if self._fd is not None:
            _os.close(self._fd)
            try:
                _os.unlink(str(self.lock_path))
            except OSError:
                pass


def locked_atomic_write(path: Path, data: dict, timeout: float = 5.0) -> None:
    """带文件锁的原子写入"""
    lock_path = Path(str(path) + ".lock")
    with FileLock(lock_path, timeout):
        atomic_write_json(path, data)


# ==================== ChromaDB 向量存储 ====================

import logging as _logging
import os as _chroma_os

_chroma_logger = _logging.getLogger(__name__)


class _CerebrateEmbeddingFunction:
    """ChromaDB 自定义嵌入函数，桥接 EmbeddingEngine"""

    def __init__(self, engine):
        self._engine = engine

    def __call__(self, input: list[str]) -> list[list[float]]:
        return self._engine.encode(input)

    def name(self) -> str:
        return f"cerebrate-{self._engine.mode}-{self._engine.dimension}"


class ChromaStore:
    """向量存储封装 — 管理单个 ChromaDB collection"""

    def __init__(self, persist_dir: Path, collection_name: str,
                 embedding_engine=None):
        self.persist_dir = persist_dir
        self.base_collection_name = collection_name
        self._engine = embedding_engine
        suffix = self._engine.mode if self._engine else "default"
        self.collection_name = f"{collection_name}_{suffix}"
        self._client = None
        self._collection = None
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

        embedding_fn = _CerebrateEmbeddingFunction(self._engine) if self._engine else None

        try:
            self._collection = self._client.get_collection(
                name=self.collection_name,
                embedding_function=embedding_fn,
            )
        except ValueError:
            # collection 不存在时创建新 collection
            self._collection = self._client.create_collection(
                name=self.collection_name,
                embedding_function=embedding_fn,
                metadata={"hnsw:space": "cosine"},
            )
        except Exception:
            # embedding function 不匹配：重建 collection
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

    # ==================== 写入 ====================

    def add(self, doc_id: str, text: str, metadata: dict,
            embedding: Optional[list[float]] = None) -> str:
        """添加文档，自动生成嵌入向量"""
        embeddings = None
        if embedding:
            embeddings = [embedding]
        self._collection.add(
            ids=[doc_id],
            documents=[text],
            metadatas=[metadata],
            embeddings=embeddings,
        )
        return doc_id

    def upsert(self, doc_id: str, text: str, metadata: dict,
               embedding: Optional[list[float]] = None):
        """插入或更新文档"""
        embeddings = None
        if embedding:
            embeddings = [embedding]
        self._collection.upsert(
            ids=[doc_id],
            documents=[text],
            metadatas=[metadata],
            embeddings=embeddings,
        )

    # ==================== 查询 ====================

    def search(self, query: str, top_k: int = 10,
               where: Optional[dict] = None,
               query_embedding: Optional[list[float]] = None) -> list[dict]:
        """向量搜索，支持元数据过滤

        where 示例:
          {"project_id": "my-project"}
          {"category": {"$in": ["coding", "debugging"]}}
          {"$and": [{"project_id": "x"}, {"category": "coding"}]}
        """
        if query_embedding:
            results = self._collection.query(
                query_embeddings=[query_embedding],
                n_results=top_k,
                where=where,
                include=["metadatas", "documents", "distances", "embeddings"],
            )
        elif self._engine:
            results = self._collection.query(
                query_embeddings=[self._engine.encode_query(query)],
                n_results=top_k,
                where=where,
                include=["metadatas", "documents", "distances", "embeddings"],
            )
        else:
            results = self._collection.query(
                query_texts=[query],
                n_results=top_k,
                where=where,
                include=["metadatas", "documents", "distances", "embeddings"],
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
                    "id": mid,
                    "metadata": meta,
                    "document": doc,
                    "distance": dist,
                    "embedding": emb,
                })
        return items

    # ==================== 读取 ====================

    def get(self, doc_id: str) -> Optional[dict]:
        """获取单个文档"""
        results = self._collection.get(
            ids=[doc_id],
            include=["metadatas", "documents", "embeddings"],
        )
        ids_list = results.get("ids") or []
        if ids_list:
            meta = results["metadatas"][0] if results.get("metadatas") else {}
            doc = results["documents"][0] if results.get("documents") else ""
            emb = None
            embs = results.get("embeddings")
            if embs is not None and len(embs) > 0:
                emb = embs[0]
            return {"id": doc_id, "metadata": meta, "document": doc, "embedding": emb}
        return None

    def get_all_ids(self) -> list[str]:
        """获取所有文档 ID"""
        results = self._collection.get(include=[])
        ids_list = results.get("ids") or []
        return ids_list

    # ==================== 更新 ====================

    def update(self, doc_id: str, metadata: dict,
               text: Optional[str] = None,
               embedding: Optional[list[float]] = None):
        """更新文档的元数据/文本/嵌入"""
        kwargs = {"ids": [doc_id], "metadatas": [metadata]}
        if text:
            kwargs["documents"] = [text]
        if embedding:
            kwargs["embeddings"] = [embedding]
        self._collection.update(**kwargs)

    # ==================== 删除 ====================

    def delete(self, doc_id: str):
        """删除文档"""
        self._collection.delete(ids=[doc_id])

    # ==================== 统计 ====================

    def count(self) -> int:
        return self._collection.count()

    def get_collection(self):
        """获取原始 ChromaDB collection（供高级操作）"""
        return self._collection

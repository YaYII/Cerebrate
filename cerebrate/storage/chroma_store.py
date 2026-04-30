"""ChromaDB 存储层 — 向量数据库统一封装

管理 ChromaDB collections，集成嵌入引擎，提供 add/search/get/update/delete API。
"""
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class _BGEembeddingFunction:
    """ChromaDB 自定义嵌入函数，桥接 EmbeddingEngine"""

    def __init__(self, engine):
        self._engine = engine

    def __call__(self, input: list[str]) -> list[list[float]]:
        return self._engine.encode(input)

    def name(self) -> str:
        return "bge-small-zh-v1.5"


class ChromaStore:
    """向量存储封装 — 管理单个 ChromaDB collection"""

    def __init__(self, persist_dir: Path, collection_name: str,
                 embedding_engine=None):
        self.persist_dir = persist_dir
        self.collection_name = collection_name
        self._engine = embedding_engine
        self._client = None
        self._collection = None
        self._init()

    def _init(self):
        import chromadb
        os.makedirs(self.persist_dir, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=str(self.persist_dir),
            settings=chromadb.Settings(anonymized_telemetry=False),
        )

        embedding_fn = None
        if self._engine and self._engine.mode == "bge":
            embedding_fn = _BGEembeddingFunction(self._engine)

        try:
            self._collection = self._client.get_collection(
                name=self.collection_name,
                embedding_function=embedding_fn,
            )
        except Exception:
            # 删除可能存在的旧 collection 后重建
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

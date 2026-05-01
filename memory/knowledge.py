"""权威知识库层 v5 — 服务端权威知识 + ChromaDB 向量存储"""
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .storage import ChromaStore
from config import config


class KnowledgeBase:
    """权威知识库：ChromaDB 向量存储后端"""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self._store: Optional[ChromaStore] = None
        self._hash_index: dict[str, str] = {}  # content_hash → doc_id
        self._init_store()
        self._build_hash_index()

    def _init_store(self):
        from .embedding import get_embedding_engine
        engine = get_embedding_engine(config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "knowledge_base", engine)

    def _build_hash_index(self):
        """启动时扫描一次，建立 content hash → doc_id 索引"""
        self._hash_index.clear()
        for did in self._store.get_all_ids():
            item = self._store.get(did)
            if item:
                h = item["metadata"].get("hash")
                if h:
                    self._hash_index[h] = did

    def flush(self):
        pass  # ChromaDB 自动持久化

    # ==================== 写入 ====================

    def store(self, title: str, content: str, source: str, topics: list[str],
              is_policy: bool = False, policy_name: str = "",
              version: str = "1.0", author: str = "",
              project_id: str = "") -> str:
        project_id = project_id or config.current_project_id
        doc_hash = hashlib.sha256(content.encode()).hexdigest()

        # O(1) 哈希索引去重
        if doc_hash in self._hash_index:
            return self._hash_index[doc_hash]

        doc_id = hashlib.sha256(
            f"{title}{source}{datetime.now(timezone.utc).isoformat()}".encode()
        ).hexdigest()[:16]

        now = datetime.now(timezone.utc).isoformat()
        search_text = f"{title}\n{content}"
        metadata = {
            "title": title,
            "content": content,
            "source": source,
            "version": version,
            "author": author,
            "topics": ",".join(topics),
            "is_policy": str(is_policy),
            "policy_name": policy_name,
            "project_id": project_id,
            "hash": doc_hash,
            "created": now,
            "updated": now,
            "access_count": 0,
            "verified": str(False),
            "deprecated": str(False),
        }

        self._store.add(doc_id, search_text, metadata)
        self._hash_index[doc_hash] = doc_id
        return doc_id

    # ==================== 查询 ====================

    def lookup(self, query: str, topic: Optional[str] = None,
               exact_policy: bool = False, project_id: Optional[str] = None) -> list[dict]:
        """向量语义查询知识库"""
        conditions = []
        if project_id is not None:
            pid = project_id if project_id else config.current_project_id
            conditions.append({"project_id": {"$in": [pid, ""]}})
        if topic:
            conditions.append({"topics": {"$contains": topic}})
        if exact_policy:
            conditions.append({"is_policy": "True"})

        where = None
        if len(conditions) == 1:
            where = conditions[0]
        elif len(conditions) > 1:
            where = {"$and": conditions}

        from .embedding import get_embedding_engine
        engine = get_embedding_engine()
        q_emb = engine.encode_query(query) if engine.mode == "bge" else None

        raw_results = self._store.search(query, top_k=10, where=where,
                                         query_embedding=q_emb)

        results = []
        for item in raw_results:
            meta = item["metadata"]
            # 更新访问计数（内存中，不触发写盘）
            self._update_access_in_meta(meta, item["id"])

            bonus = 0.0
            if meta.get("is_policy") == "True":
                bonus += 0.15
            if meta.get("verified") == "True":
                bonus += 0.1
            if meta.get("deprecated") == "True":
                bonus -= 0.3

            sem_score = 1.0 - (item["distance"] / 2.0)
            results.append({
                "doc_id": item["id"],
                "title": meta.get("title", ""),
                "content": meta.get("content", ""),
                "source": meta.get("source", ""),
                "version": meta.get("version", ""),
                "is_policy": meta.get("is_policy") == "True",
                "policy_name": meta.get("policy_name", ""),
                "topics": (meta.get("topics") or "").split(","),
                "project_id": meta.get("project_id", ""),
                "verified": meta.get("verified") == "True",
                "deprecated": meta.get("deprecated") == "True",
                "score": round(min(1.0, sem_score + bonus), 4),
            })

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:5]

    def _update_access_in_meta(self, meta: dict, doc_id: str):
        """更新访问计数（仅内存，延迟写盘）"""
        meta["access_count"] = meta.get("access_count", 0) + 1
        # 不每次都写 ChromaDB，减少 I/O

    def get_policy(self, policy_name: str) -> Optional[dict]:
        # 扫描查找匹配 policy_name
        for did in self._store.get_all_ids():
            item = self._store.get(did)
            if item and item["metadata"].get("policy_name") == policy_name:
                meta = item["metadata"]
                meta["access_count"] = meta.get("access_count", 0) + 1
                return {
                    "doc_id": item["id"],
                    "title": meta.get("title", ""),
                    "content": meta.get("content", ""),
                    "source": meta.get("source", ""),
                    "version": meta.get("version", ""),
                    "policy_name": meta.get("policy_name", ""),
                    "project_id": meta.get("project_id", ""),
                    "verified": meta.get("verified") == "True",
                    "deprecated": meta.get("deprecated") == "True",
                }
        return None

    def verify(self, doc_id: str, verified: bool = True):
        item = self._store.get(doc_id)
        if item:
            meta = item["metadata"]
            meta["verified"] = str(verified)
            meta["updated"] = datetime.now(timezone.utc).isoformat()
            text = f"{meta.get('title','')}\n{meta.get('content','')}"
            self._store.upsert(doc_id, text, meta)

    def deprecate(self, doc_id: str):
        item = self._store.get(doc_id)
        if item:
            meta = item["metadata"]
            meta["deprecated"] = str(True)
            meta["updated"] = datetime.now(timezone.utc).isoformat()
            text = f"{meta.get('title','')}\n{meta.get('content','')}"
            self._store.upsert(doc_id, text, meta)

    def list_topics(self) -> list[str]:
        topics = set()
        for did in self._store.get_all_ids()[:500]:
            item = self._store.get(did)
            if item:
                for t in (item["metadata"].get("topics") or "").split(","):
                    if t.strip():
                        topics.add(t.strip())
        return list(topics)

    def list_policies(self) -> list[str]:
        policies = set()
        for did in self._store.get_all_ids()[:500]:
            item = self._store.get(did)
            if item and item["metadata"].get("policy_name"):
                policies.add(item["metadata"]["policy_name"])
        return list(policies)

    def rebuild_semantic_index(self):
        pass  # ChromaDB 自动管理

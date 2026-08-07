"""权威知识库层 v5 — 服务端权威知识 + ChromaDB 向量存储."""
import hashlib
from datetime import UTC, datetime
from pathlib import Path

from cerebrate.config import config
from cerebrate.core.storage import ChromaStore


class KnowledgeBase:
    """权威知识库：ChromaDB 向量存储后端."""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._store: ChromaStore | None = None
        self._hash_index: dict[str, str] = {}  # content_hash → doc_id
        self._init_store()
        self._build_hash_index()

    def _init_store(self):
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine(config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "knowledge_base", engine)

    def _get_fulltext(self):
        """懒加载知识库 FTS5 全文索引（独立 db + 表前缀，与 swarm 隔离）。."""
        if not config.fulltext_enabled:
            return None
        if not hasattr(self, "_fulltext_cache"):
            from cerebrate.core.fulltext import FullTextIndex
            self._fulltext_cache = FullTextIndex(
                Path(config.memory_root) / "knowledge_fulltext.sqlite3",
                table_prefix="knowledge")
        return self._fulltext_cache

    def _fts_upsert(self, doc_id: str, *, title: str, content: str,
                    tags: str, scope: str, project_id: str,
                    created: str, updated: str) -> bool:
        """双写 FTS5（失败静默降级，不影响主写入路径）。."""
        fts = self._get_fulltext()
        if not fts or not fts.available:
            return False
        return fts.upsert(
            doc_id, title=title, content=content, tags=tags,
            category="knowledge", scope=scope, project_id=project_id,
            created=created, updated=updated,
            observation_type="knowledge")

    def _build_hash_index(self):
        """启动时扫描一次，建立 content hash → doc_id 索引."""
        self._hash_index.clear()
        for did in self._store.get_all_ids():
            item = self._store.get(did)
            if item:
                h = item["metadata"].get("hash")
                if h:
                    self._hash_index[h] = did

    def flush(self):
        """冲刷知识库（ChromaDB 自动持久化，当前为空实现占位）。."""
        pass  # ChromaDB 自动持久化

    # ==================== 写入 ====================

    def store(self, title: str, content: str, source: str, topics: list[str],
              is_policy: bool = False, policy_name: str = "",
              version: str = "1.0", author: str = "",
              project_id: str = "", scope: str = "") -> str:
        """
        存入一篇知识文档，返回 doc_id。.

        按 scope 归一化 project_id（general 清空，project 补齐当前项目）；
        内容哈希 O(1) 去重，重复内容直接返回既有 doc_id；同步双写 FTS5 全文索引。
        """
        if scope == "general":
            project_id = ""
        elif scope == "project":
            project_id = project_id or config.current_project_id
            if not project_id:
                scope = "general"
        else:
            project_id = project_id or config.current_project_id
            scope = "project" if project_id else "general"
        doc_hash = hashlib.sha256(content.encode()).hexdigest()

        # O(1) 哈希索引去重
        if doc_hash in self._hash_index:
            return self._hash_index[doc_hash]

        doc_id = hashlib.sha256(
            f"{title}{source}{datetime.now(UTC).isoformat()}".encode()
        ).hexdigest()[:16]

        now = datetime.now(UTC).isoformat()
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
            "scope": scope,
            "hash": doc_hash,
            "created": now,
            "updated": now,
            "access_count": 0,
            "verified": str(False),
            "deprecated": str(False),
        }

        self._store.add(doc_id, search_text, metadata)
        self._hash_index[doc_hash] = doc_id
        # 双写 FTS5 全文索引（精确关键词检索）
        self._fts_upsert(doc_id, title=title, content=content,
                         tags=",".join(topics), scope=scope,
                         project_id=project_id, created=now, updated=now)
        return doc_id

    def fulltext_query(self, query: str, limit: int = 20,
                       scope: str | None = None,
                       project_id: str | None = None) -> list[dict]:
        """知识库 FTS5 全文检索（精确关键词：命令/错误码/策略名）。."""
        fts = self._get_fulltext()
        if not fts or not fts.available:
            return []
        return fts.search(query, limit=limit, scope=scope, project_id=project_id)

    def rebuild_fulltext(self, batch_size: int = 200) -> dict:
        """从 ChromaDB 全量重建知识库 FTS5 索引。."""
        fts = self._get_fulltext()
        if not fts:
            return {"status": "skipped", "reason": "fulltext disabled"}
        if not fts.available:
            return {"status": "error", "reason": "fulltext unavailable"}
        fts.clear()
        indexed = 0
        failed = 0
        for did in self._store.get_all_ids():
            item = self._store.get(did)
            if not item:
                continue
            meta = item["metadata"]
            ok = self._fts_upsert(
                did, title=meta.get("title", ""),
                content=meta.get("content", ""),
                tags=meta.get("topics", ""),
                scope=meta.get("scope", "general"),
                project_id=meta.get("project_id", ""),
                created=meta.get("created", ""),
                updated=meta.get("updated", ""))
            if ok:
                indexed += 1
            else:
                failed += 1
        return {
            "status": "ok",
            "indexed": indexed,
            "failed": failed,
            "total": fts.count(),
        }

    # ==================== 查询 ====================

    def lookup(self, query: str, topic: str | None = None,
               exact_policy: bool = False, project_id: str | None = None,
               scope: str | None = None) -> list[dict]:
        """向量语义查询知识库."""
        conditions = []
        if scope == "all":
            pass
        elif scope == "general":
            conditions.append({"project_id": ""})
        elif scope == "project":
            pid = project_id if project_id else config.current_project_id
            conditions.append({"project_id": {"$in": [pid, ""]}})
        elif project_id is not None:
            pid = project_id if project_id else config.current_project_id
            conditions.append({"project_id": {"$in": [pid, ""]}})
        else:
            conditions.append({"project_id": ""})
        if topic:
            conditions.append({"topics": {"$contains": topic}})
        if exact_policy:
            conditions.append({"is_policy": "True"})

        where = None
        if len(conditions) == 1:
            where = conditions[0]
        elif len(conditions) > 1:
            where = {"$and": conditions}

        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine()
        q_emb = engine.encode_query(query) if engine.mode == "bge" else None

        raw_results = self._store.search(query, top_k=10, where=where,
                                         query_embedding=q_emb)

        results = []
        for item in raw_results:
            meta = item["metadata"]
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
                "scope": meta.get("scope", "project" if meta.get("project_id") else "general"),
                "verified": meta.get("verified") == "True",
                "deprecated": meta.get("deprecated") == "True",
                "score": round(min(1.0, sem_score + bonus), 4),
            })

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:5]

    def list_topics(self) -> list[str]:
        """返回知识库中出现的全部主题标签列表。."""
        topics = set()
        for did in self._store.get_all_ids()[:500]:
            item = self._store.get(did)
            if item:
                for t in (item["metadata"].get("topics") or "").split(","):
                    if t.strip():
                        topics.add(t.strip())
        return list(topics)

    def list_policies(self) -> list[str]:
        """返回知识库中全部策略文档名（policy_name）列表。."""
        policies = set()
        for did in self._store.get_all_ids()[:500]:
            item = self._store.get(did)
            if item and item["metadata"].get("policy_name"):
                policies.add(item["metadata"]["policy_name"])
        return list(policies)

    def update_document(self, doc_id: str, title: str, content: str,
                        metadata: dict = None):
        """更新已有文档的 ChromaDB 记录。."""
        item = self._store.get(doc_id)
        if not item:
            return False
        meta = item["metadata"]
        meta["content"] = content
        meta["title"] = title
        meta["updated"] = datetime.now(UTC).isoformat()
        if metadata:
            meta.update(metadata)
        text = f"{title}\n{content[:500]}"
        self._store.upsert(doc_id, text, meta)
        self._fts_upsert(
            doc_id, title=title, content=content,
            tags=meta.get("topics", ""),
            scope=meta.get("scope", "general"),
            project_id=meta.get("project_id", ""),
            created=meta.get("created", ""),
            updated=meta.get("updated", ""))
        return True

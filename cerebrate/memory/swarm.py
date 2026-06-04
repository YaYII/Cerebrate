"""虫群共享记忆层 v5 — 服务端权威内核 + ChromaDB 向量存储"""
import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.core.storage import ChromaStore
from cerebrate.core.decay import calculate_decay, boost_from_reuse
from cerebrate.config import config


LIFE_STAGES = {"nutrient", "memory", "verified_skill",
               "doctrine", "quarantined", "archived"}


class SwarmMemory:
    """虫群共享记忆：ChromaDB 向量存储后端"""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._store: Optional[ChromaStore] = None
        # 轻量级计数器（会话内内存，定期刷盘）
        self._stats = {"total": 0, "total_queries": 0, "total_successes": 0}
        self._dirty = False
        self._stats_lock = threading.Lock()
        self._mem_locks: dict[str, threading.Lock] = {}
        self._mem_locks_lock = threading.Lock()
        self._init_store()

    def _init_store(self):
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine(
            config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "swarm_memories", engine)

        # 从 ChromaDB 恢复计数
        self._stats["total"] = self._store.count()
        stats_item = self._store.get("_swarm_stats")
        if stats_item:
            saved = stats_item["metadata"]
            with self._stats_lock:
                self._stats["total_queries"] = int(
                    saved.get("total_queries", 0))
                self._stats["total_successes"] = int(
                    saved.get("total_successes", 0))

    def _flush_stats(self):
        """将统计计数器刷到 ChromaDB"""
        if self._store:
            with self._stats_lock:
                self._store.upsert(
                    "_swarm_stats", "swarm statistics counter", dict(self._stats))

    def flush(self):
        if self._dirty:
            self._flush_stats()
            with self._stats_lock:
                self._dirty = False

    # ==================== 写入 ====================

    def share(self, title: str, content: str, category: str, tags: list[str],
              source_agent: str = "unknown", problem_solved: str = "",
              solution: str = "", outcome: str = "success",
              project_id: str = "", language: str = "",
              life_stage: str = "memory", nutrient_score: float = 1.0,
              confidence: float = 1.0, evidence: str = "",
              supersedes: Optional[list[str]] = None) -> str:
        project_id = project_id or config.current_project_id
        language = language or config.default_language
        now = datetime.now(timezone.utc).isoformat()

        memory_id = hashlib.sha256(
            f"{title}{category}{now}".encode()
        ).hexdigest()[:16]

        life_stage = life_stage if life_stage in LIFE_STAGES else "memory"
        supersedes = supersedes or []
        search_text = f"{title}\n{content}\n{problem_solved}\n{solution}\n{evidence}"
        metadata = {
            "title": title,
            "content": content,
            "category": category,
            "tags": ",".join(tags),
            "source_agent": source_agent,
            "problem_solved": problem_solved,
            "solution": solution,
            "outcome": outcome,
            "project_id": project_id,
            "language": language,
            "score": 1.0,
            "reuse_count": 0,
            "success_count": 0,
            "life_stage": life_stage,
            "nutrient_score": float(nutrient_score),
            "confidence": float(confidence),
            "evidence": evidence,
            "supersedes": ",".join(supersedes),
            "created": now,
            "updated": now,
        }

        self._store.add(memory_id, search_text, metadata)
        with self._stats_lock:
            self._stats["total"] += 1
            self._dirty = True
        return memory_id

    # ==================== 查询 ====================

    def query(self, query_text: str, category: Optional[str] = None,
              tags: Optional[list[str]] = None, limit: int = 10,
              project_id: Optional[str] = None,
              source_agent: Optional[str] = None) -> list[dict]:
        """向量语义查询，支持元数据过滤"""
        with self._stats_lock:
            self._stats["total_queries"] += 1
            self._dirty = True

        # 构建 ChromaDB where 过滤条件
        conditions = []
        if project_id is not None:
            pid = project_id if project_id else config.current_project_id
            conditions.append({"project_id": {"$in": [pid, ""]}})
        if category:
            conditions.append({"category": category})
        if source_agent:
            conditions.append({"source_agent": source_agent})

        where = None
        if len(conditions) == 1:
            where = conditions[0]
        elif len(conditions) > 1:
            where = {"$and": conditions}

        # 向量搜索
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine()
        q_emb = engine.encode_query(
            query_text) if engine.mode == "bge" else None

        # 搜索更多结果以便后过滤（tags 不在 ChromaDB where 中处理）
        raw_results = self._store.search(query_text, top_k=max(limit * 5, 20),
                                         where=where, query_embedding=q_emb)

        # 后处理：tags 过滤 + 衰减评分
        results = []
        for item in raw_results:
            meta = item["metadata"]
            # tags 过滤（ChromaDB metadata 存为逗号分隔字符串）
            if tags:
                item_tags = set((meta.get("tags") or "").split(","))
                if not item_tags.intersection(tags):
                    continue
            if meta.get("life_stage") == "quarantined":
                continue

            decay = calculate_decay(
                created_at=meta.get("created", ""),
                last_accessed=meta.get("updated"),
                reuse_count=meta.get("reuse_count", 0),
                success_count=meta.get("success_count", 0),
                half_life_days=config.decay_half_life_days,
                outcome=meta.get("outcome", "success"),
            )
            # ChromaDB 用 cosine distance (0=完全相似, 2=完全相反)
            sem_score = 1.0 - (item["distance"] / 2.0)
            reuse_boost = boost_from_reuse(meta.get("reuse_count", 0),
                                           meta.get("success_count", 0))
            confidence = float(meta.get("confidence", 1.0) or 1.0)
            final_score = (sem_score * 0.7 + sem_score *
                           decay * 0.2 + reuse_boost) * confidence

            results.append({
                "memory_id": item["id"],
                "title": meta.get("title", ""),
                "content": meta.get("content", ""),
                "problem_solved": meta.get("problem_solved", ""),
                "solution": meta.get("solution", ""),
                "outcome": meta.get("outcome", "unknown"),
                "reuse_count": meta.get("reuse_count", 0),
                "success_count": meta.get("success_count", 0),
                "score": round(final_score, 4),
                "semantic_score": round(sem_score, 4),
                "decay": round(decay, 4),
                "life_stage": meta.get("life_stage", "memory"),
                "nutrient_score": meta.get("nutrient_score", 1.0),
                "confidence": meta.get("confidence", 1.0),
                "evidence": meta.get("evidence", ""),
                "supersedes": [s for s in (meta.get("supersedes") or "").split(",") if s],
                "category": meta.get("category", ""),
                "tags": (meta.get("tags") or "").split(","),
                "source_agent": meta.get("source_agent", "unknown"),
                "project_id": meta.get("project_id", ""),
                "language": meta.get("language", ""),
            })

        results.sort(key=lambda x: x["score"], reverse=True)
        top = results[:limit]

        if top and top[0]["score"] > 0.1:
            with self._stats_lock:
                self._stats["total_successes"] += 1
        return top

    # ==================== 反馈 ====================

    def _get_mem_lock(self, memory_id: str) -> threading.Lock:
        with self._mem_locks_lock:
            if memory_id not in self._mem_locks:
                self._mem_locks[memory_id] = threading.Lock()
            return self._mem_locks[memory_id]

    def mark_reused(self, memory_id: str, success: bool = True, feedback: str = ""):
        with self._get_mem_lock(memory_id):
            item = self._store.get(memory_id)
            if not item:
                return
            meta = item["metadata"]
            meta["reuse_count"] = meta.get("reuse_count", 0) + 1
            if success:
                meta["success_count"] = meta.get("success_count", 0) + 1
            if feedback:
                previous = meta.get("evidence", "")
                meta["evidence"] = (
                    previous + "\n" if previous else "") + feedback[:500]
            meta["updated"] = datetime.now(timezone.utc).isoformat()
            meta["score"] = self._calculate_swarm_score(meta)
            # 重建搜索文本以更新嵌入
            text = f"{meta.get('title', '')}\n{meta.get('content', '')}\n{meta.get('problem_solved', '')}\n{meta.get('solution', '')}"
            self._store.upsert(memory_id, text, meta)

    # ==================== 统计与列表 ====================

    def get_stats(self) -> dict:
        with self._stats_lock:
            return dict(self._stats)

    def list_categories(self) -> list[str]:
        metadatas = self._store.get_all_metadata(limit=1000)
        cats = set()
        for meta in metadatas:
            cat = meta.get("category", "")
            if cat:
                cats.add(cat)
        return list(cats)

    def list_projects(self) -> list[str]:
        metadatas = self._store.get_all_metadata(limit=1000)
        projects = set()
        for meta in metadatas:
            pid = meta.get("project_id", "")
            if pid:
                projects.add(pid)
        return list(projects)

    def list_tags(self) -> list[str]:
        metadatas = self._store.get_all_metadata(limit=1000)
        tagset = set()
        for meta in metadatas:
            for t in (meta.get("tags") or "").split(","):
                if t.strip():
                    tagset.add(t.strip())
        return list(tagset)

    def get_memory(self, memory_id: str) -> Optional[dict]:
        item = self._store.get(memory_id)
        if not item:
            return None
        meta = item["metadata"]
        return {
            "memory_id": item["id"],
            "title": meta.get("title", ""),
            "content": meta.get("content", ""),
            "problem_solved": meta.get("problem_solved", ""),
            "solution": meta.get("solution", ""),
            "outcome": meta.get("outcome", ""),
            "reuse_count": meta.get("reuse_count", 0),
            "success_count": meta.get("success_count", 0),
            "life_stage": meta.get("life_stage", "memory"),
            "nutrient_score": meta.get("nutrient_score", 1.0),
            "confidence": meta.get("confidence", 1.0),
            "evidence": meta.get("evidence", ""),
            "supersedes": [s for s in (meta.get("supersedes") or "").split(",") if s],
            "category": meta.get("category", ""),
            "tags": (meta.get("tags") or "").split(","),
            "source_agent": meta.get("source_agent", ""),
            "project_id": meta.get("project_id", ""),
            "created": meta.get("created", ""),
        }

    def delete_memory(self, memory_id: str) -> bool:
        item = self._store.get(memory_id)
        if not item:
            return False
        self._store.delete(memory_id)
        with self._stats_lock:
            self._stats["total"] = max(0, self._stats["total"] - 1)
            self._dirty = True
        return True

    def load_memory_raw(self, memory_id: str) -> Optional[dict]:
        """公共接口: 加载完整记忆元数据."""
        return self._load_memory(memory_id)

    def _load_memory(self, memory_id: str) -> Optional[dict]:
        """内部接口: 加载完整记忆元数据 (供进化引擎/元认知使用)."""
        item = self._store.get(memory_id)
        if not item:
            return None
        meta = item["metadata"]
        meta["memory_id"] = item["id"]
        return meta

    def update_lifecycle(self, memory_id: str, life_stage: str,
                         confidence: Optional[float] = None,
                         evidence: str = "") -> bool:
        with self._get_mem_lock(memory_id):
            item = self._store.get(memory_id)
            if not item or life_stage not in LIFE_STAGES:
                return False
            meta = item["metadata"]
            meta["life_stage"] = life_stage
            if confidence is not None:
                meta["confidence"] = float(confidence)
            if evidence:
                previous = meta.get("evidence", "")
                meta["evidence"] = (
                    previous + "\n" if previous else "") + evidence
            meta["updated"] = datetime.now(timezone.utc).isoformat()
            text = f"{meta.get('title', '')}\n{meta.get('content', '')}\n{meta.get('problem_solved', '')}\n{meta.get('solution', '')}\n{meta.get('evidence', '')}"
            self._store.upsert(memory_id, text, meta)
            return True

    def lifecycle_counts(self) -> dict:
        counts = {stage: 0 for stage in sorted(LIFE_STAGES)}
        for mid in self.get_all_memory_ids():
            item = self._store.get(mid)
            if item:
                stage = item["metadata"].get("life_stage", "memory")
                counts[stage] = counts.get(stage, 0) + 1
        return counts

    def get_all_memory_ids(self) -> list[str]:
        return self._store.get_all_ids()

    # ==================== 内部 ====================

    def _calculate_swarm_score(self, meta: dict) -> float:
        reuse = meta.get("reuse_count", 0)
        success = meta.get("success_count", 0)
        score = 0.5
        if reuse > 0:
            score += 0.3 * (success / reuse)
        score += 0.2 * min(reuse / 100, 1.0)
        return min(score, 1.0)

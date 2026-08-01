"""统一记忆管理器 v5.0 — 集成向量记忆、项目隔离、智能体注册表"""
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.memory.personal import PersonalMemory
from cerebrate.memory.swarm import SwarmMemory
from cerebrate.memory.knowledge import KnowledgeBase
from cerebrate.memory.origin import OriginLog
from cerebrate.memory.docstore import DocumentStore
from cerebrate.memory.metastore import get_metastore
from cerebrate.config import config


class MemoryManager:
    """虫群记忆总管 — 统一管理个人/虫群/知识三层记忆"""

    def __init__(self, personal_path: Path, swarm_path: Path, knowledge_path: Path):
        self.personal = PersonalMemory(personal_path)
        self.swarm = SwarmMemory(swarm_path)
        self.knowledge = KnowledgeBase(knowledge_path)
        self._agent_registry = None  # 延迟加载
        self._agent_registry_lock = threading.Lock()
        self._usage_lock = threading.Lock()
        self._origin_log: Optional[OriginLog] = None  # 延迟加载
        self._origin_lock = threading.Lock()
        self._query_log: list[dict] = []

    @property
    def agents(self):
        if self._agent_registry is None:
            with self._agent_registry_lock:
                if self._agent_registry is None:
                    from cerebrate.memory.agents import AgentRegistry
                    self._agent_registry = AgentRegistry(config.agents_path)
        return self._agent_registry

    @property
    def origin(self) -> OriginLog:
        if self._origin_log is None:
            with self._origin_lock:
                if self._origin_log is None:
                    self._origin_log = OriginLog()
        return self._origin_log

    # ==================== 个人记忆接口 ====================

    def remember_user(self, user_id: str, key: str, value,
                      confidence: float = 1.0, project_id: str = ""):
        self.personal.remember(user_id, key, value, confidence, project_id)

    def remember_project_pref(self, user_id: str, project_id: str, key: str, value):
        self.personal.remember_project_pref(user_id, project_id, key, value)

    def recall_user(self, user_id: str, key: Optional[str] = None) -> dict:
        return self.personal.recall(user_id, key)

    def get_user_profile(self, user_id: str, project_id: Optional[str] = None) -> dict:
        return self.personal.get_profile(user_id, project_id)

    def get_user_tone(self, user_id: str) -> str:
        return self.personal.get_tone(user_id)

    def get_user_name(self, user_id: str) -> str:
        return self.personal.get_name(user_id)

    def forget_user_key(self, user_id: str, key: str) -> bool:
        return self.personal.forget(user_id, key)

    # ==================== 虫群共享记忆接口 ====================

    def share_to_swarm(self, title: str, content: str, category: str, tags: list[str],
                        source_agent: str = "unknown", problem_solved: str = "",
                        solution: str = "", outcome: str = "success",
                        project_id: str = "", scope: str = "",
                        life_stage: str = "memory",
                        nutrient_score: float = 1.0, confidence: float = 1.0,
                        evidence: str = "", supersedes: Optional[list[str]] = None,
                        origin_ids: Optional[list[str]] = None,
                        physical_user: str = "",
                        memory_id: Optional[str] = None) -> str:
        memory_id = self.swarm.share(title, content, category, tags,
                                     source_agent, problem_solved, solution, outcome,
                                     project_id, scope=scope, life_stage=life_stage,
                                     nutrient_score=nutrient_score,
                                     confidence=confidence, evidence=evidence,
                                     supersedes=supersedes,
                                     origin_ids=origin_ids,
                                     physical_user=physical_user,
                                     memory_id=memory_id)
        self.agents.record_action(source_agent, "memory_shared", project_id, outcome,
                                  {"memory_id": memory_id, "life_stage": life_stage})
        return memory_id

    def query_swarm(self, query_text: str, category: Optional[str] = None,
                    tags: Optional[list[str]] = None, limit: int = 10,
                    project_id: Optional[str] = None,
                    scope: Optional[str] = None,
                    source_agent: Optional[str] = None,
                    query_texts: Optional[list[str]] = None) -> list[dict]:
        return self.swarm.query(query_text, category, tags, limit,
                                project_id, scope, source_agent,
                                query_texts=query_texts)

    def mark_swarm_reused(self, memory_id: str, success: bool = True, feedback: str = ""):
        self.swarm.mark_reused(memory_id, success, feedback)

    def _usage_store(self):
        """Lazy-init usage ChromaStore (线程安全)"""
        if not hasattr(self, "_usage_store_cache"):
            with self._usage_lock:
                if not hasattr(self, "_usage_store_cache"):
                    from cerebrate.core.embedding import get_embedding_engine
                    from cerebrate.core.storage import ChromaStore
                    engine = get_embedding_engine(
                        config.embedding_model, config.embedding_device)
                    self._usage_store_cache = ChromaStore(
                        config.chroma_path, "usage_tracking", engine)
        return self._usage_store_cache

    def start_memory_use(self, memory_id: str, agent_id: str, problem: str,
                         project_id: str = "") -> dict:
        memory = self.get_swarm_memory(memory_id)
        if not memory:
            raise ValueError(f"记忆不存在: {memory_id}")
        usage_id = str(uuid.uuid4())[:12]
        record = {
            "usage_id": usage_id,
            "memory_id": memory_id,
            "agent_id": agent_id,
            "problem": problem,
            "project_id": project_id or memory.get("project_id", ""),
            "status": "started",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "finished_at": "",
            "outcome": "",
            "feedback": "",
        }
        doc_id = f"usage:{usage_id}"
        text = f"{agent_id} {problem}"
        import json as _json
        meta = {}
        for k, v in record.items():
            meta[k] = str(v) if v is not None else ""
        self._usage_store().upsert(doc_id, text, meta)
        self.agents.record_action(agent_id, "memory_use_started",
                                  record["project_id"], "started",
                                  {"memory_id": memory_id, "problem": problem})
        return record

    def finish_memory_use(self, usage_id: str, outcome: str, feedback: str = "") -> dict:
        doc_id = f"usage:{usage_id}"
        item = self._usage_store().get(doc_id)
        if not item:
            raise ValueError(f"使用记录不存在: {usage_id}")
        record = item["metadata"]
        # Convert string metadata back to dict
        record = {k: v for k, v in record.items()}
        outcome = outcome if outcome in {
            "success", "partial", "failure"} else "partial"
        record.update({
            "status": "finished",
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "outcome": outcome,
            "feedback": feedback,
        })
        import json as _json
        meta = {}
        for k, v in record.items():
            meta[k] = str(v) if v is not None else ""
        text = f"{record.get('agent_id', '')} {record.get('problem', '')}"
        self._usage_store().upsert(doc_id, text, meta)
        self.mark_swarm_reused(record["memory_id"], success=outcome == "success",
                               feedback=feedback)
        self.agents.record_action(record["agent_id"], "memory_use_finished",
                                  record.get("project_id", ""), outcome,
                                  {"memory_id": record["memory_id"],
                                   "usage_id": usage_id,
                                   "feedback": feedback})
        return record

    def get_swarm_stats(self) -> dict:
        return self.swarm.get_stats()

    def get_swarm_categories(self) -> list[str]:
        return self.swarm.list_categories()

    def get_swarm_memory(self, memory_id: str) -> Optional[dict]:
        return self.swarm.get_memory(memory_id)

    # ==================== 权威知识库接口 ====================

    def store_knowledge(self, title: str, content: str, source: str, topics: list[str],
                        is_policy: bool = False, policy_name: str = "",
                        version: str = "1.0", author: str = "",
                        project_id: str = "", scope: str = "") -> str:
        return self.knowledge.store(title, content, source, topics,
                                    is_policy, policy_name, version, author,
                                    project_id, scope)

    def lookup_knowledge(self, query: str, topic: Optional[str] = None,
                         exact_policy: bool = False,
                         project_id: Optional[str] = None,
                         scope: Optional[str] = None) -> list[dict]:
        return self.knowledge.lookup(query, topic, exact_policy, project_id, scope)

    def get_policy(self, policy_name: str) -> Optional[dict]:
        return self.knowledge.get_policy(policy_name)

    def verify_knowledge(self, doc_id: str, verified: bool = True):
        self.knowledge.verify(doc_id, verified)

    def deprecate_knowledge(self, doc_id: str):
        self.knowledge.deprecate(doc_id)

    # ==================== 智能体接口 ====================

    def register_agent(self, agent_id: str, agent_type: str = "cli",
                       capabilities: Optional[list[str]] = None,
                       metadata: Optional[dict] = None,
                       physical_user: str = "") -> dict:
        return self.agents.register(agent_id, agent_type, capabilities, metadata,
                                    physical_user=physical_user)

    def list_agents(self) -> list[str]:
        return self.agents.list_active()

    def record_agent_action(self, agent_id: str, action_type: str,
                            project_id: str = "", outcome: str = "success",
                            details: Optional[dict] = None):
        self.agents.record_action(
            agent_id, action_type, project_id, outcome, details)

    # ==================== 统计与维护 ====================

    def get_all_stats(self) -> dict:
        swarm_stats = self.swarm.get_stats()
        swarm_count = self.swarm._store.count(
        ) if self.swarm._store else swarm_stats.get("total", 0)
        kb_count = self.knowledge._store.count() if self.knowledge._store else 0
        return {
            "version": "5.0.0",
            "personal": {"user_count": len(self.personal.list_users())},
            "swarm": swarm_stats,
            "lifecycle": self.swarm.lifecycle_counts(),
            "scope": self.swarm.scope_counts(),
            "knowledge": {
                "document_count": kb_count,
                "topic_count": len(self.knowledge.list_topics()),
                "policy_count": len(self.knowledge.list_policies()),
            },
            "agents": {"registered": len(self.agents.list_active())},
            "vector": {
                "swarm_docs": swarm_count,
                "kb_docs": kb_count,
                "embedding_mode": self.swarm._store.embedding_mode if self.swarm._store else "unknown",
            },
        }

    def log_query(self, user_id: str, query: str, route: str, results: int):
        self._query_log.append({
            "user_id": user_id,
            "query": query,
            "route": route,
            "results": results,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        if len(self._query_log) > 1000:
            self._query_log = self._query_log[-500:]

    def get_query_log(self, limit: int = 50) -> list[dict]:
        return self._query_log[-limit:]

    # ==================== 刷盘 ====================

    def flush_all(self):
        """将会话中累积的内存统计变更刷到磁盘（会话结束时调用）"""
        self.swarm.flush()
        self.knowledge.flush()
        self.personal.flush()

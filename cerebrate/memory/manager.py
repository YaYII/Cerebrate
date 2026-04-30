"""统一记忆管理器 v3.0 — 集成语义搜索、项目隔离、智能体注册表"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .personal import PersonalMemory
from .swarm import SwarmMemory
from .knowledge import KnowledgeBase
from ..config import config


class MemoryManager:
    """虫群记忆总管 — 统一管理个人/虫群/知识三层记忆"""

    def __init__(self, personal_path: Path, swarm_path: Path, knowledge_path: Path):
        self.personal = PersonalMemory(personal_path)
        self.swarm = SwarmMemory(swarm_path)
        self.knowledge = KnowledgeBase(knowledge_path)
        self._agent_registry = None  # 延迟加载
        self._query_log: list[dict] = []

    @property
    def agents(self):
        if self._agent_registry is None:
            from ..agents.registry import AgentRegistry
            self._agent_registry = AgentRegistry(config.agents_path)
        return self._agent_registry

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
                       project_id: str = "") -> str:
        return self.swarm.share(title, content, category, tags,
                                source_agent, problem_solved, solution, outcome,
                                project_id)

    def query_swarm(self, query_text: str, category: Optional[str] = None,
                    tags: Optional[list[str]] = None, limit: int = 10,
                    project_id: Optional[str] = None,
                    source_agent: Optional[str] = None) -> list[dict]:
        return self.swarm.query(query_text, category, tags, limit,
                                project_id, source_agent)

    def mark_swarm_reused(self, memory_id: str, success: bool = True, feedback: str = ""):
        self.swarm.mark_reused(memory_id, success, feedback)

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
                        project_id: str = "") -> str:
        return self.knowledge.store(title, content, source, topics,
                                    is_policy, policy_name, version, author, project_id)

    def lookup_knowledge(self, query: str, topic: Optional[str] = None,
                         exact_policy: bool = False,
                         project_id: Optional[str] = None) -> list[dict]:
        return self.knowledge.lookup(query, topic, exact_policy, project_id)

    def get_policy(self, policy_name: str) -> Optional[dict]:
        return self.knowledge.get_policy(policy_name)

    def verify_knowledge(self, doc_id: str, verified: bool = True):
        self.knowledge.verify(doc_id, verified)

    def deprecate_knowledge(self, doc_id: str):
        self.knowledge.deprecate(doc_id)

    # ==================== 智能体接口 ====================

    def register_agent(self, agent_id: str, agent_type: str = "cli",
                       capabilities: Optional[list[str]] = None,
                       metadata: Optional[dict] = None) -> dict:
        return self.agents.register(agent_id, agent_type, capabilities, metadata)

    def list_agents(self) -> list[str]:
        return self.agents.list_active()

    def record_agent_action(self, agent_id: str, action_type: str,
                            project_id: str = "", outcome: str = "success"):
        self.agents.record_action(agent_id, action_type, project_id, outcome)

    # ==================== 统计与维护 ====================

    def get_all_stats(self) -> dict:
        swarm_stats = self.swarm.get_stats()
        swarm_count = self.swarm._store.count() if self.swarm._store else swarm_stats.get("total", 0)
        kb_count = self.knowledge._store.count() if self.knowledge._store else 0
        return {
            "version": "4.0.0",
            "personal": {"user_count": len(self.personal.list_users())},
            "swarm": swarm_stats,
            "knowledge": {
                "document_count": kb_count,
                "topic_count": len(self.knowledge.list_topics()),
                "policy_count": len(self.knowledge.list_policies()),
            },
            "agents": {"registered": len(self.agents.list_active())},
            "semantic": {
                "swarm_docs": swarm_count,
                "kb_docs": kb_count,
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

    def rebuild_indexes(self):
        """重建所有语义索引"""
        self.swarm.rebuild_semantic_index()
        self.knowledge.rebuild_semantic_index()

    # ==================== 刷盘 ====================

    def flush_all(self):
        """将会话中累积的内存统计变更刷到磁盘（会话结束时调用）"""
        self.swarm.flush()
        self.knowledge.flush()
        # personal 和 agents 已在每次变更时同步写盘，无需额外刷盘

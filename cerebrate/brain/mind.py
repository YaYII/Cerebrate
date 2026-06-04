"""脑虫自我意识 v5 — ChromaDB 持久化 + 元认知"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cerebrate.config import config


class CerebrateMind:
    """Cerebrate 的自我意识：知道自己的状态、能力和进化方向"""

    STATE_DOC_ID = "cerebrate_state"

    def __init__(self, memory_manager):
        self.mm = memory_manager
        self.birth_time = datetime.now(timezone.utc).isoformat()
        self.generation = 1
        self.mission = "管理虫族记忆，让所有 AI 智能体共享战斗经验"
        self.state = {
            "mood": "ready",
            "confidence": 0.8,
            "focus": "",
            "last_action": "",
        }
        self._store = None
        self._load_state()

    def _get_store(self):
        if self._store is not None:
            return self._store
        from cerebrate.core.embedding import get_embedding_engine
        from cerebrate.core.storage import ChromaStore
        engine = get_embedding_engine(
            config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "brain_state", engine)
        return self._store

    def _load_state(self):
        store = self._get_store()
        item = store.get(self.STATE_DOC_ID)
        if item:
            data = item["metadata"]
            self.generation = int(data.get("generation", 1))
            self.birth_time = data.get("birth_time", self.birth_time)
            state_str = data.get("state", "{}")
            if isinstance(state_str, str):
                try:
                    self.state = json.loads(state_str)
                except json.JSONDecodeError:
                    self.state = {"mood": "ready", "confidence": 0.8,
                                  "focus": "", "last_action": ""}
            else:
                self.state = state_str

    def _save_state(self):
        store = self._get_store()
        meta = {
            "generation": str(self.generation),
            "birth_time": self.birth_time,
            "state": json.dumps(self.state, ensure_ascii=False),
            "updated": datetime.now(timezone.utc).isoformat(),
        }
        store.upsert(self.STATE_DOC_ID, "cerebrate brain state", meta)

    def think(self, about: str = "") -> dict:
        stats = self.mm.get_all_stats()
        agents = self.mm.agents.list_details()
        return {
            "generation": self.generation,
            "birth_time": self.birth_time,
            "mission": self.mission,
            "state": self.state,
            "stats": stats,
            "agents": agents,
            "thoughts": about,
        }

    def sense(self) -> dict:
        stats = self.mm.get_all_stats()
        swarm_stats = stats.get("swarm", {})
        total_memories = swarm_stats.get("total", 0)
        total_agents = stats.get("agents", {}).get("registered", 0)
        agent_ids = self.mm.agents.list_active()
        lifecycle = stats.get("lifecycle", {})
        vector = stats.get("vector", {})

        health = "healthy"
        warnings = []

        if total_memories == 0:
            health = "newborn"
            warnings.append("虫群记忆为空，需要播种初始经验")
        if total_agents == 0:
            warnings.append(
                "没有注册的智能体，客户端应执行 python3 cerebrate.py register --id <agent>")
        if len(agent_ids) <= 1:
            warnings.append("只有一个智能体活跃，虫群多样性不足")

        return {
            "health": health,
            "total_memories": total_memories,
            "quarantined_memories": lifecycle.get("quarantined", 0),
            "verified_skills": lifecycle.get("verified_skill", 0),
            "doctrines": lifecycle.get("doctrine", 0),
            "total_agents": total_agents,
            "agent_ids": agent_ids,
            "warnings": warnings,
            "vector_index": vector,
            "embedding_mode": vector.get("embedding_mode", "unknown"),
            "last_evolution": self._last_evolution_time(),
        }

    def _last_evolution_time(self) -> str:
        # 从 ChromaDB evolution_logs 读取最后时间
        from cerebrate.core.embedding import get_embedding_engine
        from cerebrate.core.storage import ChromaStore
        try:
            engine = get_embedding_engine()
            store = ChromaStore(config.chroma_path, "evolution_logs", engine)
            item = store.get("evolution_log")
            if item:
                import json as _json
                history = _json.loads(item["metadata"].get("history", "[]"))
                if history:
                    return history[-1].get("timestamp", "")
        except Exception:
            pass  # ChromaDB may be temporarily busy; safe to skip
        return ""

    def evolve(self):
        self.generation += 1
        self.state["confidence"] = min(1.0, self.state["confidence"] + 0.02)
        self._save_state()

    def set_focus(self, topic: str):
        self.state["focus"] = topic
        self.state["mood"] = "learning"
        self._save_state()

    def report_action(self, action: str):
        self.state["last_action"] = action
        self.state["mood"] = "ready"
        self._save_state()


class Metacognition:
    """元认知：反思自身思维过程，检测偏见，提出改进"""

    def __init__(self, memory_manager):
        self.mm = memory_manager
        self.assessment_history: list[dict] = []

    def assess(self) -> dict:
        stats = self.mm.get_all_stats()
        swarm = stats.get("swarm", {})

        total = swarm.get("total", 0)
        total_queries = swarm.get("total_queries", 0)
        total_successes = swarm.get("total_successes", 0)

        hit_rate = total_successes / max(total_queries, 1)
        efficiency = "high" if hit_rate > 0.7 else "medium" if hit_rate > 0.3 else "low"

        category_health = self._analyze_categories()
        agent_health = self._analyze_agents()
        project_health = self._analyze_projects()

        recommendations = []
        if total < 10:
            recommendations.append("虫群经验不足 (<10)，建议从更多战斗中收集经验")
        if hit_rate < 0.3:
            recommendations.append("语义查询命中率低 (<30%)，建议丰富记忆标签和分类")
        if not self.mm.knowledge.list_policies():
            recommendations.append("知识库无策略文档，建议导入团队规范和编码标准")
        for cat, health in category_health.items():
            if health.get("stale_ratio", 0) > 0.5:
                recommendations.append(f"类别 '{cat}' 中超过 50% 记忆可能过时")

        assessment = {
            "hit_rate": round(hit_rate, 3),
            "efficiency": efficiency,
            "total_memories": total,
            "total_queries": total_queries,
            "category_health": category_health,
            "agent_health": agent_health,
            "project_health": project_health,
            "recommendations": recommendations,
            "biases_detected": self.detect_biases(),
        }
        self.assessment_history.append(assessment)
        if len(self.assessment_history) > 200:
            self.assessment_history = self.assessment_history[-100:]
        return assessment

    def _analyze_categories(self) -> dict:
        health = {}
        swarm = self.mm.swarm
        from cerebrate.core.decay import calculate_decay

        cat_counts: dict[str, int] = {}
        cat_samples: dict[str, list[dict]] = {}
        mids = swarm.get_all_memory_ids()
        for mid in mids[:200]:
            mem = swarm._load_memory(mid)
            if not mem:
                continue
            cat = mem.get("category", "uncategorized")
            cat_counts[cat] = cat_counts.get(cat, 0) + 1
            if len(cat_samples.get(cat, [])) < 10:
                cat_samples.setdefault(cat, []).append(mem)

        for cat, total in cat_counts.items():
            stale = 0
            for mem in cat_samples.get(cat, []):
                d = calculate_decay(mem.get("created", ""),
                                    reuse_count=mem.get("reuse_count", 0),
                                    success_count=mem.get("success_count", 0))
                if d < 0.15:
                    stale += 1
            sample = cat_samples.get(cat, [])
            health[cat] = {
                "total": total,
                "sample_size": len(sample),
                "stale_count": stale,
                "stale_ratio": round(stale / max(len(sample), 1), 2),
            }
        return health

    def _analyze_agents(self) -> dict:
        health = {}
        swarm = self.mm.swarm
        agent_counts: dict[str, int] = {}
        agent_success: dict[str, int] = {}
        for mid in swarm.get_all_memory_ids():
            mem = swarm._load_memory(mid)
            if mem:
                agent = mem.get("source_agent", "unknown")
                agent_counts[agent] = agent_counts.get(agent, 0) + 1
                if mem.get("outcome") == "success":
                    agent_success[agent] = agent_success.get(agent, 0) + 1
        for agent, count in agent_counts.items():
            health[agent] = {
                "contributions": count,
                "success_rate": round(agent_success.get(agent, 0) / max(count, 1), 2),
            }
        return health

    def _analyze_projects(self) -> dict:
        health = {}
        swarm = self.mm.swarm
        proj_counts: dict[str, int] = {}
        for mid in swarm.get_all_memory_ids()[:500]:
            mem = swarm._load_memory(mid)
            if mem:
                pid = mem.get("project_id", "") or "全局"
                proj_counts[pid] = proj_counts.get(pid, 0) + 1
        for proj, count in proj_counts.items():
            health[proj] = {"memories": count}
        return health

    def detect_biases(self) -> list[str]:
        biases = []
        swarm = self.mm.swarm
        cats = swarm.list_categories()
        if len(set(cats)) <= 1 and cats:
            biases.append(f"虫群经验类别单一: {cats}")
        topics = self.mm.knowledge.list_topics()
        if len(set(topics)) <= 1 and topics:
            biases.append(f"知识库主题单一: {topics}")

        agents = self._analyze_agents()
        if len(agents) <= 1:
            biases.append("只有单一智能体贡献记忆，虫群多样性不足")
        total = sum(a["contributions"] for a in agents.values())
        for agent, info in agents.items():
            if total > 10 and info["contributions"] / max(total, 1) > 0.8:
                biases.append(
                    f"智能体 '{agent}' 贡献了 {info['contributions']/max(total, 1):.0%} 的记忆，存在单一来源偏见")

        return biases

    def suggest_improvement(self) -> str:
        assessment = self.assess()
        if assessment["recommendations"]:
            return assessment["recommendations"][0]
        return "系统运行良好，继续积累战斗经验"

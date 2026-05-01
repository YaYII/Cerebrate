"""虫群自我意识 v3.1 — 动态注册表 + 持久化状态"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..config import config
from ..storage.atomic import atomic_write_json


class CerebrateMind:
    """Cerebrate 的自我意识：知道自己的状态、能力和进化方向"""

    STATE_FILE = "cerebrate_state.json"

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
        self._load_state()

    def _state_path(self) -> Path:
        return config.evolution_path / self.STATE_FILE

    def _load_state(self):
        sp = self._state_path()
        if sp.exists():
            data = json.loads(sp.read_text())
            self.generation = data.get("generation", 1)
            self.birth_time = data.get("birth_time", self.birth_time)
            self.state = data.get("state", self.state)
        else:
            self._save_state()

    def _save_state(self):
        sp = self._state_path()
        sp.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(sp, {
            "generation": self.generation,
            "birth_time": self.birth_time,
            "state": self.state,
            "updated": datetime.now(timezone.utc).isoformat(),
        })

    def think(self, about: str = "") -> dict:
        """自我反思，汇报当前状态"""
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
        """感知系统状态 — 快速健康检查"""
        stats = self.mm.get_all_stats()
        swarm_stats = stats.get("swarm", {})
        total_memories = swarm_stats.get("total", 0)
        total_agents = stats.get("agents", {}).get("registered", 0)
        agent_ids = self.mm.agents.list_active()
        lifecycle = stats.get("lifecycle", {})
        semantic = stats.get("semantic", {})

        health = "healthy"
        warnings = []

        if total_memories == 0:
            health = "newborn"
            warnings.append("虫群记忆为空，需要播种初始经验")
        if total_agents == 0:
            warnings.append("没有注册的智能体，执行 python3 cerebrate.py agent register --id claude-code")
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
            "semantic_index": semantic,
            "embedding_mode": semantic.get("embedding_mode", "unknown"),
            "last_evolution": self._last_evolution_time(),
        }

    def _last_evolution_time(self) -> str:
        log_path = config.evolution_path / "_evolution_log.json"
        if not log_path.exists():
            return ""
        try:
            history = json.loads(log_path.read_text())
        except json.JSONDecodeError:
            return ""
        if not history:
            return ""
        return history[-1].get("timestamp", "")

    def evolve(self):
        """进化到下一代"""
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

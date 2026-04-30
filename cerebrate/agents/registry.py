"""智能体注册表 v3.1 — 内存缓存 + 原子写入"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..storage.atomic import atomic_write_json


class AgentRegistry:
    """管理所有连接到虫群的 AI 智能体"""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self._agents: dict[str, dict] = {}        # 索引摘要
        self._agent_cache: dict[str, dict] = {}    # agent_id → 完整信息
        self._load_all()

    def _index_path(self) -> Path: return self.storage_path / "_agents_index.json"
    def _agent_file(self, agent_id: str) -> Path:
        return self.storage_path / f"{agent_id}.json"

    def _load_all(self):
        """启动时加载索引和所有 agent 文件到内存"""
        idx = self._index_path()
        if idx.exists():
            self._agents = json.loads(idx.read_text())
        else:
            self._agents = {}

        # 全量加载所有 agent 详情到缓存
        for aid in list(self._agents.keys()):
            info = self._load_agent_file(aid)
            if info:
                self._agent_cache[aid] = info

    def _load_agent_file(self, agent_id: str) -> Optional[dict]:
        f = self._agent_file(agent_id)
        if f.exists():
            return json.loads(f.read_text())
        return None

    def _save(self):
        atomic_write_json(self._index_path(), self._agents)

    def register(self, agent_id: str, agent_type: str = "cli",
                 capabilities: Optional[list[str]] = None,
                 metadata: Optional[dict] = None) -> dict:
        """注册或更新智能体"""
        now = datetime.now(timezone.utc).isoformat()
        if agent_id in self._agent_cache:
            info = self._agent_cache[agent_id]
        else:
            info = {
                "agent_id": agent_id,
                "agent_type": agent_type,
                "capabilities": capabilities or [],
                "metadata": metadata or {},
                "registered_at": now,
                "total_actions": 0,
                "success_count": 0,
                "action_log": [],
            }

        info["agent_type"] = agent_type
        if capabilities:
            info["capabilities"] = list(set(info.get("capabilities", []) + capabilities))
        if metadata:
            info["metadata"].update(metadata)
        info["last_active"] = now

        # 内存 + 磁盘
        self._agent_cache[agent_id] = info
        atomic_write_json(self._agent_file(agent_id), info)

        self._agents[agent_id] = {
            "agent_type": agent_type,
            "last_active": now,
            "total_actions": info["total_actions"],
            "success_rate": (info["success_count"] / max(info["total_actions"], 1)),
        }
        self._save()
        return info

    def unregister(self, agent_id: str) -> bool:
        if agent_id not in self._agents:
            return False
        del self._agents[agent_id]
        self._agent_cache.pop(agent_id, None)
        self._agent_file(agent_id).unlink(missing_ok=True)
        self._save()
        return True

    def get(self, agent_id: str) -> Optional[dict]:
        return self._agent_cache.get(agent_id)

    def list_active(self) -> list[str]:
        return list(self._agents.keys())

    def list_details(self) -> list[dict]:
        result = []
        for aid, info in self._agent_cache.items():
            result.append({
                "agent_id": aid,
                "agent_type": info.get("agent_type", ""),
                "capabilities": info.get("capabilities", []),
                "total_actions": info.get("total_actions", 0),
                "success_rate": info.get("success_count", 0) / max(info.get("total_actions", 1), 1),
                "last_active": info.get("last_active", ""),
                "registered_at": info.get("registered_at", ""),
            })
        return result

    def record_action(self, agent_id: str, action_type: str,
                      project_id: str = "", outcome: str = "success",
                      details: Optional[dict] = None) -> None:
        """记录智能体的一次操作"""
        info = self._agent_cache.get(agent_id) or {}
        now = datetime.now(timezone.utc).isoformat()

        info.setdefault("action_log", []).append({
            "action_type": action_type,
            "project_id": project_id,
            "outcome": outcome,
            "details": details or {},
            "timestamp": now,
        })

        info["total_actions"] = info.get("total_actions", 0) + 1
        if outcome == "success":
            info["success_count"] = info.get("success_count", 0) + 1
        info["last_active"] = now

        if len(info.get("action_log", [])) > 500:
            info["action_log"] = info["action_log"][-200:]

        # 内存 + 磁盘
        self._agent_cache[agent_id] = info
        atomic_write_json(self._agent_file(agent_id), info)

        if agent_id in self._agents:
            self._agents[agent_id].update({
                "last_active": now,
                "total_actions": info["total_actions"],
                "success_rate": info["success_count"] / max(info["total_actions"], 1),
            })
        self._save()

    def get_stats(self, agent_id: str) -> Optional[dict]:
        info = self._agent_cache.get(agent_id)
        if not info:
            return None
        return {
            "agent_id": agent_id,
            "agent_type": info.get("agent_type", ""),
            "total_actions": info.get("total_actions", 0),
            "success_count": info.get("success_count", 0),
            "success_rate": info.get("success_count", 0) / max(info.get("total_actions", 1), 1),
            "capabilities": info.get("capabilities", []),
            "last_active": info.get("last_active", ""),
            "registered_at": info.get("registered_at", ""),
        }

    def is_registered(self, agent_id: str) -> bool:
        return agent_id in self._agents

"""智能体注册表 v5 — ChromaDB 后端，高并发安全."""
import threading
from datetime import UTC, datetime
from pathlib import Path

from cerebrate.config import config
from cerebrate.core.storage import ChromaStore


class AgentRegistry:
    """管理所有连接到虫群的 AI 智能体."""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._store: ChromaStore | None = None
        self._cache: dict[str, dict] = {}  # agent_id -> 完整信息
        self._cache_lock = threading.Lock()
        self._init_store()
        self._import_legacy()

    def _init_store(self):
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine(
            config.embedding_model, config.embedding_device)
        self._store = ChromaStore(
            config.chroma_path, "agents_registry", engine)

    def _import_legacy(self):
        """从 ChromaDB 加载所有 agent 到缓存。."""
        self._load_from_chroma()

    def _load_from_chroma(self):
        """从 ChromaDB 加载所有 agent 到缓存."""
        for did in self._store.get_all_ids():
            item = self._store.get(did)
            if not item:
                continue
            meta = item["metadata"]

            # 反序列化
            info = {}
            for k, v in meta.items():
                if k in ("capabilities", "metadata", "action_log"):
                    import json
                    try:
                        info[k] = json.loads(v)
                    except (json.JSONDecodeError, TypeError):
                        info[k] = v
                elif k in ("total_actions", "success_count", "partial_count", "failure_count", "memory_contributions"):
                    info[k] = int(v) if v else 0
                elif k == "last_active":
                    info[k] = str(v)
                else:
                    info[k] = str(v) if v is not None else ""
            info["agent_id"] = meta.get("agent_id", "")

            aid = meta.get("agent_id", "")
            if aid:
                self._cache[aid] = info

    def _persist(self, agent_id: str):
        """写回单个 agent."""
        with self._cache_lock:
            info = self._cache.get(agent_id)
            if not info:
                return
            import json as _json
            doc_id = f"agent:{agent_id}"
            text = f"{agent_id} {info.get('agent_type', '')}"
            meta = {}
            for k, v in info.items():
                if isinstance(v, (list, dict)):
                    meta[k] = _json.dumps(v, ensure_ascii=False)
                elif isinstance(v, bool):
                    meta[k] = str(v)
                elif isinstance(v, (int, float)):
                    meta[k] = v
                else:
                    meta[k] = str(v) if v is not None else ""
            self._store.upsert(doc_id, text, meta)

    # ==================================================================

    def register(self, agent_id: str, agent_type: str = "cli",
                 capabilities: list[str] | None = None,
                 metadata: dict | None = None,
                 physical_user: str = "") -> dict:
        """
        注册或更新智能体信息，返回智能体完整档案 dict。.

        已注册则合并 capabilities/metadata 并刷新 last_active；未注册则创建新档案。
        注册后持久化到 agents 存储。
        """
        now = datetime.now(UTC).isoformat()
        with self._cache_lock:
            if agent_id in self._cache:
                info = self._cache[agent_id]
            else:
                info = {
                    "agent_id": agent_id,
                    "agent_type": agent_type,
                    "physical_user": physical_user or "",
                    "capabilities": capabilities or [],
                    "metadata": metadata or {},
                    "registered_at": now,
                    "total_actions": 0,
                    "success_count": 0,
                    "partial_count": 0,
                    "failure_count": 0,
                    "memory_contributions": 0,
                    "action_log": [],
                }

            if physical_user:
                info["physical_user"] = physical_user
            info["agent_type"] = agent_type
            if capabilities:
                info["capabilities"] = list(
                    set(info.get("capabilities", []) + capabilities))
            if metadata:
                info["metadata"].update(metadata)
            info["last_active"] = now

            self._cache[agent_id] = info
        self._persist(agent_id)
        return info

    def get(self, agent_id: str) -> dict | None:
        """按 agent_id 读取智能体档案，未注册返回 None。."""
        with self._cache_lock:
            return self._cache.get(agent_id)

    def list_active(self) -> list[str]:
        """返回当前已注册（活跃）的智能体 ID 列表。."""
        with self._cache_lock:
            return list(self._cache.keys())

    def list_details(self) -> list[dict]:
        """返回全部智能体的详细信息列表（含成功率/贡献数/最近活跃时间）。."""
        with self._cache_lock:
            result = []
            for aid, info in self._cache.items():
                sc = info.get("success_count", 0)
                ta = max(info.get("total_actions", 1), 1)
                result.append({
                    "agent_id": aid,
                    "agent_type": info.get("agent_type", ""),
                    "physical_user": info.get("physical_user", ""),
                    "capabilities": info.get("capabilities", []),
                    "total_actions": info.get("total_actions", 0),
                    "memory_contributions": info.get("memory_contributions", 0),
                    "success_rate": sc / ta,
                    "last_active": info.get("last_active", ""),
                    "registered_at": info.get("registered_at", ""),
                })
            return result

    def record_action(self, agent_id: str, action_type: str,
                      project_id: str = "", outcome: str = "success",
                      details: dict | None = None) -> None:
        """
        记录一次智能体动作（计入 total_actions 与 outcome 计数）。.

        未注册的智能体会被隐式创建（默认 cli 类型），用于事后统计贡献与成功率。
        """
        now = datetime.now(UTC).isoformat()
        with self._cache_lock:
            info = self._cache.get(agent_id)
            if not info:
                info = {
                    "agent_id": agent_id,
                    "agent_type": "cli",
                    "capabilities": [],
                    "metadata": {},
                    "registered_at": now,
                    "total_actions": 0,
                    "success_count": 0,
                    "partial_count": 0,
                    "failure_count": 0,
                    "memory_contributions": 0,
                    "action_log": [],
                }

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
            elif outcome == "partial":
                info["partial_count"] = info.get("partial_count", 0) + 1
            elif outcome == "failure":
                info["failure_count"] = info.get("failure_count", 0) + 1
            if action_type == "memory_shared":
                info["memory_contributions"] = info.get(
                    "memory_contributions", 0) + 1
            info["last_active"] = now

            if len(info.get("action_log", [])) > 500:
                info["action_log"] = info["action_log"][-200:]

            self._cache[agent_id] = info
        self._persist(agent_id)

    def get_physical_user(self, agent_id: str) -> str:
        """查询 agent 对应的物理用户（操作系统用户名），用于安全溯源。."""
        with self._cache_lock:
            info = self._cache.get(agent_id)
            if info:
                return info.get("physical_user", "")
        return ""

    def get_stats(self, agent_id: str) -> dict | None:
        """返回智能体统计（动作数/成功率/贡献数等），未注册返回 None。."""
        with self._cache_lock:
            info = self._cache.get(agent_id)
            if not info:
                return None
            sc = info.get("success_count", 0)
            ta = max(info.get("total_actions", 1), 1)
            return {
                "agent_id": agent_id,
                "agent_type": info.get("agent_type", ""),
                "total_actions": info.get("total_actions", 0),
                "success_count": sc,
                "partial_count": info.get("partial_count", 0),
                "failure_count": info.get("failure_count", 0),
                "success_rate": sc / ta,
                "memory_contributions": info.get("memory_contributions", 0),
                "capabilities": info.get("capabilities", []),
                "last_active": info.get("last_active", ""),
                "registered_at": info.get("registered_at", ""),
            }

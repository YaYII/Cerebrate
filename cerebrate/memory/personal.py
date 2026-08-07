"""个人记忆层 v5 — 服务端用户上下文 + ChromaDB 持久化."""
import threading
from datetime import UTC, datetime
from pathlib import Path

from cerebrate.config import config
from cerebrate.core.storage import ChromaStore


class PersonalMemory:
    """个人记忆：ChromaDB 后端 + 内存缓存."""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self._cache: dict[str, dict] = {}  # user_id → {key: {value, ...}}
        self._store: ChromaStore | None = None
        self._index: dict = {"users": {}}  # 用户列表
        self._dirty_access: set[str] = set()  # access_count 变更待刷盘的 doc_id
        self._lock = threading.Lock()
        self._init_store()
        self._load_all_to_cache()

    def _init_store(self):
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine(
            config.embedding_model, config.embedding_device)
        self._store = ChromaStore(
            config.chroma_path, "personal_memories", engine)

    def _load_all_to_cache(self):
        """启动时从 ChromaDB 全量加载到内存."""
        for pid in self._store.get_all_ids():
            item = self._store.get(pid)
            if not item:
                continue
            meta = item["metadata"]
            uid = meta.get("user_id", "")
            key = meta.get("key", "")
            if uid and key:
                self._cache.setdefault(uid, {})[key] = {
                    "value": meta.get("value", ""),
                    "confidence": meta.get("confidence", 1.0),
                    "updated": meta.get("updated", ""),
                    "project_id": meta.get("project_id", ""),
                    "access_count": meta.get("access_count", 0),
                }
                self._index["users"].setdefault(uid, {
                    "first_seen": meta.get("updated", ""),
                    "last_seen": meta.get("updated", ""),
                })

    def flush(self):
        """将缓存的 access_count 变更批量写回 ChromaDB."""
        with self._lock:
            if not self._dirty_access:
                return
            for doc_id in list(self._dirty_access):
                parts = doc_id.split(":", 1)
                if len(parts) != 2:
                    continue
                uid, key = parts
                entry = self._cache.get(uid, {}).get(key)
                if not entry:
                    continue
                item = self._store.get(doc_id)
                if item:
                    meta = item["metadata"]
                    meta["access_count"] = entry.get("access_count", 0)
                    text = f"{key}: {entry.get('value', '')}"
                    self._store.upsert(doc_id, text, meta)
            self._dirty_access.clear()

    # ==================== 读写 ====================

    def remember(self, user_id: str, key: str, value,
                 confidence: float = 1.0, project_id: str = "") -> None:
        """
        写入一条个人偏好 user_id/key → value。.

        同时更新内存缓存与用户索引（first_seen/last_seen），覆盖同 key 旧值。
        """
        now = datetime.now(UTC).isoformat()
        doc_id = f"{user_id}:{key}"
        meta = {
            "user_id": user_id, "key": key, "value": str(value),
            "confidence": confidence, "updated": now,
            "project_id": project_id, "access_count": 0,
        }
        text = f"{key}: {value}"
        self._store.upsert(doc_id, text, meta)

        # 更新缓存
        self._cache.setdefault(user_id, {})[key] = {
            "value": str(value), "confidence": confidence,
            "updated": now, "project_id": project_id, "access_count": 0,
        }
        if user_id not in self._index["users"]:
            self._index["users"][user_id] = {"first_seen": now}
        self._index["users"][user_id]["last_seen"] = now

    def set_loadout(self, user_id: str, *, bound_projects: list[str] | None = None,
                    preferred_scope: str = "",
                    bound_tags: list[str] | None = None) -> dict:
        """
        用户 Loadout 装配（v5.2，借鉴 TencentDB Agent Memory Loadout）。.

        用户配置自己的记忆装配：绑定的项目 / 偏好 scope / 绑定标签。
        检索时自动应用（未显式传参时用装配值，且装配项目/标签优先召回）。
        """
        loadout = {
            "bound_projects": [p.strip() for p in (bound_projects or [])
                               if p and p.strip()],
            "preferred_scope": (preferred_scope or "").strip(),
            "bound_tags": [t.strip() for t in (bound_tags or [])
                           if t and t.strip()],
        }
        # 存 JSON 字符串（remember 内部 str() 不会破坏合法 JSON）
        import json
        self.remember(user_id, "loadout", json.dumps(
            loadout, ensure_ascii=False), confidence=1.0)
        return loadout

    def get_loadout(self, user_id: str) -> dict:
        """读取用户 Loadout 装配（无则返回空装配）。."""
        raw = self._cache.get(user_id, {}).get("loadout", {}).get("value", {})
        if isinstance(raw, dict):
            return {
                "bound_projects": raw.get("bound_projects", []),
                "preferred_scope": raw.get("preferred_scope", ""),
                "bound_tags": raw.get("bound_tags", []),
            }
        if isinstance(raw, str) and raw.strip().startswith("{"):
            try:
                import json
                raw = json.loads(raw)
                return {
                    "bound_projects": raw.get("bound_projects", []),
                    "preferred_scope": raw.get("preferred_scope", ""),
                    "bound_tags": raw.get("bound_tags", []),
                }
            except (json.JSONDecodeError, TypeError):
                pass
        return {"bound_projects": [], "preferred_scope": "",
                "bound_tags": []}

    def recall(self, user_id: str, key: str | None = None) -> dict:
        """纯内存读取."""
        data = self._cache.get(user_id, {})
        if key:
            entry = data.get(key, {})
            if entry:
                with self._lock:
                    entry["access_count"] = entry.get("access_count", 0) + 1
                    self._dirty_access.add(f"{user_id}:{key}")
                return {key: entry.get("value", "")}
            return {}
        result = {}
        for k, v in data.items():
            result[k] = v.get("value", "") if isinstance(v, dict) else v
        return result

    def get_profile(self, user_id: str, project_id: str | None = None) -> dict:
        """组装用户画像 dict（偏好/事实/历史/统计），供会话开始注入上下文。."""
        data = self._cache.get(user_id, {})
        profile = {
            "user_id": user_id,
            "preferences": {},
            "facts": {},
            "history": [],
            "project_contexts": {},
        }
        for k, v in data.items():
            if not isinstance(v, dict):
                continue
            val = v.get("value", "")

            if k.startswith("pref_"):
                profile["preferences"][k[5:]] = val
            elif k.startswith("fact_"):
                profile["facts"][k[5:]] = val
            elif k.startswith("history_"):
                profile["history"].append(val)
            elif k.startswith("proj_"):
                rest = k[5:]
                parts = rest.split("_", 1)
                if len(parts) == 2:
                    p_id, p_key = parts
                    profile["project_contexts"].setdefault(p_id, {})[
                        p_key] = val

        if project_id:
            profile["project_contexts"] = {
                project_id: profile["project_contexts"].get(project_id, {})
            }
        return profile

    def get_tone(self, user_id: str) -> str:
        """返回用户偏好语气（pref_tone），未设置时默认「专业简洁」。."""
        prefs = self.recall(user_id, "pref_tone")
        return prefs.get("pref_tone", "专业简洁")

    def list_users(self) -> list:
        """返回已记录的用户 ID 列表。."""
        return list(self._index.get("users", {}).keys())

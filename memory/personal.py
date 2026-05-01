"""个人记忆层 v5 — 服务端用户上下文 + ChromaDB 持久化"""
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .storage import ChromaStore
from config import config


class PersonalMemory:
    """个人记忆：ChromaDB 后端 + 内存缓存"""

    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, dict] = {}  # user_id → {key: {value, ...}}
        self._store: Optional[ChromaStore] = None
        self._index: dict = {"users": {}}  # 用户列表
        self._dirty_access: set[str] = set()  # access_count 变更待刷盘的 doc_id
        self._init_store()
        self._load_all_to_cache()

    def _init_store(self):
        from .embedding import get_embedding_engine
        engine = get_embedding_engine(config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "personal_memories", engine)

    def _load_all_to_cache(self):
        """启动时从 ChromaDB 全量加载到内存"""
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
        """将缓存的 access_count 变更批量写回 ChromaDB"""
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
        now = datetime.now(timezone.utc).isoformat()
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

    def remember_project_pref(self, user_id: str, project_id: str,
                              key: str, value) -> None:
        self.remember(user_id, f"proj_{project_id}_{key}", value,
                      project_id=project_id)

    def recall(self, user_id: str, key: Optional[str] = None) -> dict:
        """纯内存读取"""
        data = self._cache.get(user_id, {})
        if key:
            entry = data.get(key, {})
            if entry:
                entry["access_count"] = entry.get("access_count", 0) + 1
                self._dirty_access.add(f"{user_id}:{key}")
                return {key: entry.get("value", "")}
            return {}
        result = {}
        for k, v in data.items():
            result[k] = v.get("value", "") if isinstance(v, dict) else v
        return result

    def get_profile(self, user_id: str, project_id: Optional[str] = None) -> dict:
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
            pid = v.get("project_id", "")

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
                    profile["project_contexts"].setdefault(p_id, {})[p_key] = val

        if project_id:
            profile["project_contexts"] = {
                project_id: profile["project_contexts"].get(project_id, {})
            }
        return profile

    def get_tone(self, user_id: str) -> str:
        prefs = self.recall(user_id, "pref_tone")
        return prefs.get("pref_tone", "专业简洁")

    def get_language(self, user_id: str) -> str:
        prefs = self.recall(user_id, "pref_language")
        return prefs.get("pref_language", "简体中文")

    def get_name(self, user_id: str) -> str:
        facts = self.recall(user_id, "fact_name")
        return facts.get("fact_name", "")

    def list_users(self) -> list:
        return list(self._index.get("users", {}).keys())

    def forget(self, user_id: str, key: str) -> bool:
        data = self._cache.get(user_id, {})
        if key in data:
            del data[key]
            doc_id = f"{user_id}:{key}"
            try:
                self._store.delete(doc_id)
            except Exception:
                pass
            return True
        return False

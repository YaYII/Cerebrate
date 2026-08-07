"""短期场景存储 v5.2 — 进行中任务的场景上下文（借鉴 TencentDB Agent Memory L2）

与长期记忆（swarm/knowledge）分离：
  - 场景是进行中任务的短期上下文（session 级），任务结束后可蒸馏沉淀为长期技能
  - ingest 记录原始事件（零 LLM 成本，实时可用）
  - compress 用 LLM 生成/更新 Mermaid 认知状态机（token 压缩，受蒸馏窗口约束省钱）

存储：config.memory_root/scenes/{session_id}.json（文件系统，不占向量库）。
session_id 严格校验（防路径穿越，对齐腾讯 storage local-backend CR-6 修复）。
"""

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


SAFE_SESSION_RE = re.compile(r"^[a-zA-Z0-9_.\-]{1,100}$")


class SceneStore:
    """短期场景存储：session_id → 事件流 + Mermaid 压缩图 + 元数据"""

    def __init__(self, storage_path: Path):
        self.storage_path = Path(storage_path)
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    # ── 内部工具 ──

    def _path(self, session_id: str) -> Path:
        if not SAFE_SESSION_RE.match(session_id or ""):
            raise ValueError(
                f"session_id 非法（须 1-100 位字母数字/_.-）: {session_id!r}")
        return self.storage_path / f"{session_id}.json"

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _load(self, session_id: str) -> dict:
        path = self._path(session_id)
        if not path.exists():
            return {
                "session_id": session_id,
                "events": [],
                "mmd": None,
                "meta": {},
                "created": self._now(),
                "updated": self._now(),
            }
        try:
            with open(path) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            data = {"session_id": session_id, "events": [],
                    "mmd": None, "meta": {}, "created": self._now()}
        data.setdefault("events", [])
        data.setdefault("mmd", None)
        data.setdefault("meta", {})
        return data

    def _save(self, data: dict) -> None:
        data["updated"] = self._now()
        path = self._path(data["session_id"])
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        tmp.replace(path)

    # ── 写入 ──

    def ingest(self, session_id: str, events: list[dict],
               prompt: str = "") -> dict:
        """追加原始事件（零 LLM 成本）。events: [{ts, kind: tool|msg, text}]"""
        with self._lock:
            data = self._load(session_id)
            now = self._now()
            for ev in events or []:
                data["events"].append({
                    "ts": ev.get("ts") or now,
                    "kind": ev.get("kind", "tool"),
                    "text": (ev.get("text") or "")[:2000],
                })
            if prompt:
                data["events"].append({
                    "ts": now, "kind": "msg", "text": prompt[:2000]})
            # 上限 200 条：超出后只保留最近 200（场景是短期记忆，不无限增长）
            if len(data["events"]) > 200:
                data["events"] = data["events"][-200:]
            self._save(data)
            return self._summary(data)

    def update_meta(self, session_id: str, **meta) -> dict:
        """更新场景元数据（task_goal/progress/status 等，compress 时写入）。"""
        with self._lock:
            data = self._load(session_id)
            data["meta"].update({k: v for k, v in meta.items()
                                 if v is not None})
            self._save(data)
            return self._summary(data)

    # ── 读取 ──

    def get(self, session_id: str) -> dict:
        data = self._load(session_id)
        return {
            "session_id": data["session_id"],
            "event_count": len(data["events"]),
            "events": data["events"][-50:],  # 只返回最近 50 条（防上下文膨胀）
            "mmd": data.get("mmd"),
            "meta": data.get("meta", {}),
            "created": data.get("created", ""),
            "updated": data.get("updated", ""),
        }

    def get_mmd(self, session_id: str) -> Optional[str]:
        return self._load(session_id).get("mmd")

    def set_mmd(self, session_id: str, mmd: str,
                meta: Optional[dict] = None) -> dict:
        """写入 Mermaid 压缩图（compress 成功后调用）。"""
        with self._lock:
            data = self._load(session_id)
            data["mmd"] = mmd
            if meta:
                data["meta"].update(meta)
            self._save(data)
            return self._summary(data)

    def list_sessions(self, limit: int = 100) -> list[dict]:
        sessions = []
        for path in sorted(self.storage_path.glob("*.json")):
            if path.name.endswith(".tmp"):
                continue
            try:
                with open(path) as f:
                    data = json.load(f)
            except (json.JSONDecodeError, OSError):
                continue
            sessions.append({
                "session_id": data.get("session_id", path.stem),
                "event_count": len(data.get("events", [])),
                "has_mmd": bool(data.get("mmd")),
                "task_goal": (data.get("meta") or {}).get("task_goal", ""),
                "updated": data.get("updated", ""),
            })
            if len(sessions) >= limit:
                break
        sessions.sort(key=lambda s: s["updated"], reverse=True)
        return sessions

    def delete(self, session_id: str) -> bool:
        with self._lock:
            path = self._path(session_id)
            if path.exists():
                path.unlink()
                return True
            return False

    def _summary(self, data: dict) -> dict:
        return {
            "session_id": data["session_id"],
            "event_count": len(data["events"]),
            "has_mmd": bool(data.get("mmd")),
            "updated": data.get("updated", ""),
        }

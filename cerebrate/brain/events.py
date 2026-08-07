"""
Authoritative server event log — ChromaDB-backed.

Connections are disposable; this append-only log is the durable source of
truth for memory continuity, consensus votes, and brain state changes.
"""

import json
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

from cerebrate.config import config
from cerebrate.core.storage import ChromaStore


def _flatten_metadata(d: dict) -> dict:
    """Convert nested dict/list values to JSON strings for ChromaDB compatibility."""
    result = {}
    for k, v in d.items():
        if v is None:
            result[k] = ""
        elif isinstance(v, (dict, list)):
            result[k] = json.dumps(v, ensure_ascii=False)
        elif isinstance(v, bool):
            result[k] = str(v)
        elif isinstance(v, (int, float)):
            result[k] = v
        else:
            result[k] = str(v)
    return result


class EventLog:
    """Append-only event log backed by ChromaDB with resumable event ids."""

    def __init__(self, root: Path | None = None):
        self._store: ChromaStore | None = None
        self._seq_lock = threading.Lock()
        self._init_store()

    def _init_store(self):
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine(
            config.embedding_model, config.embedding_device)
        self._store = ChromaStore(config.chroma_path, "events_log", engine)

    def append(self, event_type: str, source_agent: str = "brain-server",
               payload: dict | None = None, project_id: str = "") -> dict:
        """
        追加一条事件到 append-only 事件日志。.

        线程安全：加锁分配递增 event_id，写入事件记录并更新序号游标。
        返回完整事件 dict（含 event_id/event_uid/timestamp）。
        """
        with self._seq_lock:
            seq = self._next_sequence()
            event = {
                "event_id": seq,
                "event_uid": str(uuid.uuid4()),
                "event_type": event_type,
                "timestamp": datetime.now(UTC).isoformat(),
                "source_agent": source_agent,
                "project_id": project_id,
                "payload": payload or {},
            }
            doc_id = f"event:{seq}"
            text = f"{event_type} {source_agent} {json.dumps(payload or {}, ensure_ascii=False)}"
            meta = _flatten_metadata(event)
            self._store.upsert(doc_id, text, meta)
            seq_meta = {"last_event_id": seq,
                        "updated": datetime.now(UTC).isoformat()}
            self._store.upsert("_seq", "sequence counter", seq_meta)
            return event

    def read_after(self, cursor: int = 0, limit: int = 100) -> list[dict]:
        """读取 event_id 大于 cursor 的事件（按 event_id 升序，最多 limit 条）。."""
        all_ids = self._store.get_all_ids()
        events = []
        for eid in all_ids:
            if eid == "_seq":
                continue
            try:
                seq = int(eid.split(":", 1)[1]) if eid.startswith(
                    "event:") else int(eid)
            except (ValueError, IndexError):
                continue
            if seq <= cursor:
                continue
            item = self._store.get(eid)
            if item:
                meta = item["metadata"]
                payload_str = meta.get("payload", "{}")
                try:
                    payload = json.loads(payload_str)
                except json.JSONDecodeError:
                    payload = {}
                events.append({
                    "event_id": int(meta.get("event_id", seq)),
                    "event_uid": meta.get("event_uid", ""),
                    "event_type": meta.get("event_type", ""),
                    "timestamp": meta.get("timestamp", ""),
                    "source_agent": meta.get("source_agent", ""),
                    "project_id": meta.get("project_id", ""),
                    "payload": payload,
                })
        events.sort(key=lambda x: x["event_id"])
        return events[:limit]

    def list_recent(self, limit: int = 5000) -> list[dict]:
        """
        返回最近的 limit 条事件（按 event_id 升序）。.

        渐进式披露 timeline 层使用：扫描最近事件，围绕 anchor 记忆构建时序上下文。
        只读取最近 limit 条（按 event_id 取尾部），避免全量扫描。
        """
        all_ids = self._store.get_all_ids()
        seqs = []
        for eid in all_ids:
            if eid == "_seq":
                continue
            try:
                seq = int(eid.split(":", 1)[1]) if eid.startswith(
                    "event:") else int(eid)
            except (ValueError, IndexError):
                continue
            seqs.append((seq, eid))
        seqs.sort(key=lambda x: x[0])
        tail = seqs[-max(0, limit):]

        events = []
        for seq, eid in tail:
            item = self._store.get(eid)
            if not item:
                continue
            meta = item["metadata"]
            payload_str = meta.get("payload", "{}")
            try:
                payload = json.loads(payload_str)
            except json.JSONDecodeError:
                payload = {}
            events.append({
                "event_id": int(meta.get("event_id", seq)),
                "event_uid": meta.get("event_uid", ""),
                "event_type": meta.get("event_type", ""),
                "timestamp": meta.get("timestamp", ""),
                "source_agent": meta.get("source_agent", ""),
                "project_id": meta.get("project_id", ""),
                "payload": payload,
            })
        events.sort(key=lambda x: x["event_id"])
        return events

    def latest_id(self) -> int:
        """
        返回当前最新事件 ID（无事件时为 0）。.

        优先读取 _seq 游标记录；缺失时扫描全部事件取最大 event_id 兜底。
        """
        seq_item = self._store.get("_seq")
        if seq_item:
            return int(seq_item["metadata"].get("last_event_id", 0))
        max_id = 0
        for eid in self._store.get_all_ids():
            if eid == "_seq":
                continue
            try:
                seq = int(eid.split(":", 1)[1]) if eid.startswith(
                    "event:") else int(eid)
            except (ValueError, IndexError):
                continue
            max_id = max(max_id, seq)
        return max_id

    def _next_sequence(self) -> int:
        return self.latest_id() + 1

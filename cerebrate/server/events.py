"""Authoritative server event log.

Connections are disposable; this append-only log is the durable source of
truth for memory continuity, consensus votes, and brain state changes.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..config import config
from ..storage.atomic import FileLock, atomic_write_json


class EventLog:
    """Append-only JSONL event log with resumable event ids."""

    def __init__(self, root: Optional[Path] = None):
        self.root = root or config.events_path
        self.root.mkdir(parents=True, exist_ok=True)
        self.events_file = self.root / "events.jsonl"
        self.seq_file = self.root / "_seq.json"
        self.lock_file = self.root / ".events.lock"

    def append(self, event_type: str, source_agent: str = "brain-server",
               payload: Optional[dict] = None, project_id: str = "") -> dict:
        with FileLock(self.lock_file, timeout=30.0):
            seq = self._next_sequence()
            event = {
                "event_id": seq,
                "event_uid": str(uuid.uuid4()),
                "event_type": event_type,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "source_agent": source_agent,
                "project_id": project_id,
                "payload": payload or {},
            }
            with self.events_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
            return event

    def read_after(self, cursor: int = 0, limit: int = 100) -> list[dict]:
        if not self.events_file.exists():
            return []
        events = []
        # 流式读取，不一次性加载整个文件到内存
        with self.events_file.open("r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    event = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                if int(event.get("event_id", 0)) > cursor:
                    events.append(event)
                if len(events) >= limit:
                    break
        return events

    def latest_id(self) -> int:
        if not self.seq_file.exists():
            return 0
        try:
            return int(json.loads(self.seq_file.read_text()).get("last_event_id", 0))
        except (ValueError, json.JSONDecodeError):
            return 0

    def _next_sequence(self) -> int:
        seq = self.latest_id() + 1
        atomic_write_json(self.seq_file, {"last_event_id": seq})
        return seq

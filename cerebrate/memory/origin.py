"""原始记忆日志 v5 — 不可变 append-only 存储

每条记忆写入虫群时，在此保留完整原始副本。不可修改、不可删除。
共享记忆通过 origin_ids 引用此处的原始记录，实现完整审计溯源。

超过保留期的原始记忆可备份后安全清除。
"""

import hashlib
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from cerebrate.config import config
from cerebrate.core.storage import ChromaStore


class OriginLog:
    """不可变原始记忆日志。

    只提供 add / get 操作，无 update / delete。
    每条原始记录关联到一条共享记忆 (memory_id)。
    """

    def __init__(self, chroma_path: Optional[Path] = None):
        self._store: Optional[ChromaStore] = None
        self._count: int = 0
        self._lock = threading.Lock()
        self._init_store(chroma_path)

    def _init_store(self, chroma_path: Optional[Path] = None):
        from cerebrate.core.embedding import get_embedding_engine
        engine = get_embedding_engine(
            config.embedding_model, config.embedding_device)
        store_path = chroma_path or config.chroma_path
        self._store = ChromaStore(store_path, "origin_log", engine)
        self._count = self._store.count()

    # ── 写入 ──────────────────────────────────────────────

    def add(self, memory_id: str, payload: dict) -> str:
        """写入一条原始记忆记录，返回 origin_id。

        Args:
            memory_id: 关联的共享记忆 ID
            payload: 完整的原始请求数据（含 title, content, tags, agent 等）

        Returns:
            origin_id: 原始记录唯一标识
        """
        now = datetime.now(timezone.utc).isoformat()
        origin_id = hashlib.sha256(
            f"origin:{memory_id}:{now}".encode()
        ).hexdigest()[:20]

        # 将 payload 序列化为 JSON 字符串，确保不可变性
        payload_json = json.dumps(payload, ensure_ascii=False)
        metadata = {
            "origin_id": origin_id,
            "memory_id": memory_id,
            "payload_json": payload_json,
            "title": str(payload.get("title", "")),
            "category": str(payload.get("category", "")),
            "source_agent": str(payload.get("agent_id", payload.get("agent", ""))),
            "physical_user": str(payload.get("physical_user", "")),
            "project_id": str(payload.get("project_id", "")),
            "life_stage": str(payload.get("life_stage", "memory")),
            "recorded_at": now,
        }
        text = f"origin {origin_id} → {memory_id}: {payload.get('title', '')}"
        self._store.add(origin_id, text, metadata)
        with self._lock:
            self._count += 1
        return origin_id

    # ── 读取 ──────────────────────────────────────────────

    def get(self, origin_id: str) -> Optional[dict]:
        """按 origin_id 读取原始记忆完整内容。

        Returns:
            dict 含 origin_id, memory_id, payload (原始数据), recorded_at 等；
            不存在返回 None。
        """
        item = self._store.get(origin_id)
        if not item:
            return None
        meta = item["metadata"]
        payload_json = meta.get("payload_json", "{}")
        try:
            payload = json.loads(payload_json)
        except json.JSONDecodeError:
            payload = {}
        return {
            "origin_id": meta.get("origin_id", origin_id),
            "memory_id": meta.get("memory_id", ""),
            "payload": payload,
            "title": meta.get("title", ""),
            "category": meta.get("category", ""),
            "source_agent": meta.get("source_agent", ""),
            "physical_user": meta.get("physical_user", ""),
            "project_id": meta.get("project_id", ""),
            "life_stage": meta.get("life_stage", ""),
            "recorded_at": meta.get("recorded_at", ""),
        }

    def get_by_memory_id(self, memory_id: str) -> list[dict]:
        """查询关联到某条共享记忆的所有原始记录。

        通常只有一条，但进化合并后可能有多条。
        """
        results = []
        for did in self._store.get_all_ids():
            if did.startswith("_") or did == "_seq":
                continue
            item = self._store.get(did)
            if not item:
                continue
            meta = item["metadata"]
            if meta.get("memory_id") == memory_id:
                results.append(self.get(did))
        results.sort(key=lambda x: x.get("recorded_at", ""))
        return results

    def list_ids(self) -> list[str]:
        """列出所有原始记录 ID。"""
        return [did for did in self._store.get_all_ids()
                if not did.startswith("_")]

    # ── 清理与备份 ──────────────────────────────────────

    def get_old_origins(self, days: int = 365) -> list[dict]:
        """获取超过指定天数的原始记录列表。

        Args:
            days: 保留天数，默认 365 天

        Returns:
            list[dict]: 每条记录含 origin_id, memory_id, title, recorded_at
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        old = []
        for did in self._store.get_all_ids():
            if did.startswith("_") or did == "_seq":
                continue
            item = self._store.get(did)
            if not item:
                continue
            meta = item["metadata"]
            recorded_str = meta.get("recorded_at", "")
            try:
                recorded = datetime.fromisoformat(recorded_str)
                if recorded.tzinfo is None:
                    recorded = recorded.replace(tzinfo=timezone.utc)
            except (ValueError, TypeError):
                continue
            if recorded < cutoff:
                old.append({
                    "origin_id": meta.get("origin_id", did),
                    "memory_id": meta.get("memory_id", ""),
                    "title": meta.get("title", ""),
                    "recorded_at": recorded_str,
                })
        old.sort(key=lambda x: x["recorded_at"])
        return old

    def delete_origin(self, origin_id: str) -> bool:
        """删除单条原始记录（仅限过期清理调用）。"""
        with self._lock:
            item = self._store.get(origin_id)
            if not item:
                return False
            self._store.delete(origin_id)
            self._count = max(0, self._count - 1)
            return True

    def backup_origins(self, origin_ids: list[str], backup_dir: str) -> str:
        """将指定原始记录导出为 JSON 备份文件。

        Args:
            origin_ids: 要备份的 origin_id 列表
            backup_dir: 备份目录路径

        Returns:
            备份文件路径；无数据返回空字符串
        """
        if not origin_ids:
            return ""
        os.makedirs(backup_dir, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        filename = f"origin_backup_{timestamp}.json"
        filepath = os.path.join(backup_dir, filename)

        records = []
        for oid in origin_ids:
            record = self.get(oid)
            if record:
                records.append(record)

        if not records:
            return ""

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump({
                "backup_time": datetime.now(timezone.utc).isoformat(),
                "count": len(records),
                "records": records,
            }, f, ensure_ascii=False, indent=2)

        return filepath

    def cleanup_expired(self, days: int = 365,
                        backup_dir: str = "/data/origin_backups") -> dict:
        """清理超过保留期的原始记忆：先备份再删除（防删策略）。

        备份失败则中止删除，保护数据安全。
        days <= 0 表示不清理（默认防删：原始记忆永久保留归档，
        符合「任何记忆都有原始记忆的归档，防止被删除」）。

        Args:
            days: 保留天数；<=0 表示永不删除（仅跳过，不删任何记录）
            backup_dir: 备份目录

        Returns:
            操作结果统计
        """
        if days is None or days <= 0:
            # 防删：原始归档永久保留，不清理（显式手动清理仍可传正数天数）
            return {
                "total_expired": 0,
                "backed_up": 0,
                "deleted": 0,
                "backup_file": "",
                "skipped": True,
                "message": "原始记忆保留策略为永久保留（CEREBRATE_ORIGIN_RETENTION_DAYS<=0），跳过清理",
            }
        days = max(days, 1)  # 正数时最少保留 1 天，防止误删全部
        old = self.get_old_origins(days)
        old_ids = [r["origin_id"] for r in old]
        result = {
            "total_expired": len(old),
            "backed_up": 0,
            "deleted": 0,
            "backup_file": "",
        }

        if not old_ids:
            return result

        # 先备份（备份失败则中止，防止数据丢失）
        backup_file = self.backup_origins(old_ids, backup_dir)
        if not backup_file:
            result["error"] = "备份失败，已中止删除操作以保护数据"
            return result

        result["backup_file"] = backup_file
        result["backed_up"] = len(old_ids)

        # 备份成功后再删除
        for oid in old_ids:
            if self.delete_origin(oid):
                result["deleted"] += 1

        return result

    @property
    def count(self) -> int:
        with self._lock:
            return self._count

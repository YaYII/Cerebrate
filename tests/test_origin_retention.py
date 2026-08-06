"""原始记忆归档保留策略测试（归档防删，2026-08-06）。

用户要求：任何记忆都有原始记忆的归档，防止被删除。
默认策略：CEREBRATE_ORIGIN_RETENTION_DAYS<=0 → 永不清理（跳过）。
正数天数（显式手动清理）保留原有「先备份再删除」行为。
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def configure_temp_memory(tmp_name):
    from cerebrate.config import config
    import cerebrate.core.embedding as embedding

    root = Path(tmp_name) / "memory"
    config.memory_root = root
    config.personal_path = root / "personal"
    config.swarm_path = root / "swarm"
    config.knowledge_path = root / "knowledge"
    config.evolution_path = root / "evolution"
    config.agents_path = root / "agents"
    config.events_path = root / "events"
    config.chroma_path = root / "chroma_data"
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    config.memory_min_tokens = 0
    embedding._engine = None


def make_payload(mid):
    return {
        "title": f"原始记忆 {mid}",
        "content": "保留策略测试内容",
        "category": "testing",
        "tags": "retention,test",
        "agent_id": "retention-agent",
        "physical_user": "retention-user",
        "project_id": "retention-test",
        "problem": "验证归档防删",
        "solution": "默认永久保留",
    }


class OriginRetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from cerebrate.memory.origin import OriginLog
        self.origin = OriginLog()
        self.oid1 = self.origin.add("mem-ret-1", make_payload("mem-ret-1"))
        self.oid2 = self.origin.add("mem-ret-2", make_payload("mem-ret-2"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_config_is_never_delete(self):
        from cerebrate.config import config
        self.assertLessEqual(config.origin_retention_days, 0)

    def test_cleanup_skip_when_days_zero(self):
        result = self.origin.cleanup_expired(days=0)
        self.assertTrue(result.get("skipped"))
        self.assertEqual(result["deleted"], 0)
        # 记录仍完整存在
        self.assertIsNotNone(self.origin.get(self.oid1))
        self.assertIsNotNone(self.origin.get(self.oid2))

    def test_cleanup_skip_when_days_negative(self):
        result = self.origin.cleanup_expired(days=-5)
        self.assertTrue(result.get("skipped"))
        self.assertEqual(result["deleted"], 0)

    def test_cleanup_skip_when_days_none(self):
        result = self.origin.cleanup_expired(days=None)
        self.assertTrue(result.get("skipped"))
        self.assertEqual(result["deleted"], 0)

    def test_positive_days_fresh_records_not_deleted(self):
        result = self.origin.cleanup_expired(days=365)
        self.assertFalse(result.get("skipped", False))
        self.assertEqual(result["total_expired"], 0)
        self.assertEqual(result["deleted"], 0)
        self.assertIsNotNone(self.origin.get(self.oid1))

    def test_positive_days_old_records_backup_then_delete(self):
        # 把一条记录的时间改写成 400 天前，验证正数天数走「先备份再删除」
        import json
        from datetime import datetime, timedelta, timezone
        item = self.origin._store.get(self.oid1)
        old_meta = dict(item["metadata"])
        old_meta["recorded_at"] = (
            datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
        self.origin._store.upsert(self.oid1, item["document"], old_meta)

        result = self.origin.cleanup_expired(
            days=365, backup_dir=str(Path(self.tmp.name) / "backups"))
        self.assertEqual(result["total_expired"], 1)
        self.assertEqual(result["deleted"], 1)
        self.assertTrue(result["backup_file"])
        self.assertIsNone(self.origin.get(self.oid1))
        # 未过期的仍保留
        self.assertIsNotNone(self.origin.get(self.oid2))


if __name__ == "__main__":
    unittest.main()

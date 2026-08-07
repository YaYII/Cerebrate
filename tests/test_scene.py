"""短期场景存储自检 — Mermaid 场景压缩（借鉴 TencentDB Agent Memory L2）

需求（v5.2 借鉴点）:
  - ingest 追加原始事件（零 LLM 成本）
  - get 返回最近事件 + Mermaid 图 + 元数据
  - compress 走 LLM（受蒸馏窗口约束；LLM 不可用降级）
  - list/delete 生命周期
  - session_id 防路径穿越
"""
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def configure_temp_env(tmp_name):
    import cerebrate.core.embedding as embedding
    from cerebrate.config import config

    root = Path(tmp_name) / "memory"
    config.memory_root = root
    config.personal_path = root / "personal"
    config.swarm_path = root / "swarm"
    config.knowledge_path = root / "knowledge"
    config.evolution_path = root / "evolution"
    config.agents_path = root / "agents"
    config.events_path = root / "events"
    config.chroma_path = root / "chroma_data"
    config.docstore_path = root / "docstore"
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    config.embedding_max_length = 8192
    config.embedding_summary_chars = 1000
    config.chunk_enabled = True
    config.chunk_max_chars = 2000
    config.chunk_min_chars = 100
    config.chunk_overlap_chars = 50
    config.context_expand_enabled = False
    config.relevance_filter_enabled = False
    config.reranker_enabled = False
    config.query_rewrite_enabled = False
    config.memory_min_tokens = 0
    embedding._engine = None


class SceneApiTests(unittest.TestCase):
    """场景 API 端到端测试"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self._tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self._tmp.cleanup()

    def test_ingest_get_list_delete(self):
        """ingest → get → list → delete 全链路。"""
        r = self.api.scene_ingest({
            "session_id": "task-001",
            "events": [
                {"kind": "tool", "text": "exec: 查看日志"},
                {"kind": "msg", "text": "发现 500 错误"},
            ],
            "prompt": "排查登录 500",
        })
        self.assertEqual(r["event_count"], 3)

        g = self.api.scene_get({"session_id": "task-001"})
        self.assertEqual(g["session_id"], "task-001")
        self.assertEqual(g["event_count"], 3)
        self.assertIsNone(g["mmd"])

        lst = self.api.scene_list()["sessions"]
        self.assertTrue(any(s["session_id"] == "task-001" for s in lst))

        d = self.api.scene_delete({"session_id": "task-001"})
        self.assertTrue(d["deleted"])
        self.assertEqual(
            self.api.scene_get({"session_id": "task-001"})["event_count"], 0)

    def test_ingest_caps_at_200_events(self):
        """事件上限 200 条：超出后只保留最近 200。"""
        events = [{"kind": "tool", "text": f"evt-{i}"} for i in range(210)]
        r = self.api.scene_ingest({"session_id": "big", "events": events})
        self.assertEqual(r["event_count"], 200)

    def test_session_id_path_traversal_rejected(self):
        """防路径穿越：非法 session_id 抛 ValueError。"""
        with self.assertRaises(ValueError):
            self.api.scene_ingest(
                {"session_id": "../../etc/passwd", "events": []})
        with self.assertRaises(ValueError):
            self.api.scene_get({"session_id": "a/b"})

    def test_compress_window_gate(self):
        """窗口外 compress 被拦截（force 逃生门）。"""
        from cerebrate.config import config
        config.evolution_window_enabled = True
        config.evolution_window_start_hour = 0
        config.evolution_window_end_hour = 1
        config.evolution_window_tz_offset_hours = 8
        # 模拟本地 12:00（窗口外）
        local_noon_utc = datetime(2026, 8, 7, 12) - timedelta(hours=8)
        with patch("cerebrate.config.datetime", wraps=datetime) as mock_dt:
            mock_dt.now.return_value = local_noon_utc.replace(tzinfo=UTC)
            self.api.scene_ingest(
                {"session_id": "s1", "events": [{"kind": "msg", "text": "x"}]})
            r = self.api.scene_compress({"session_id": "s1"})
        self.assertFalse(r["compressed"])
        self.assertIn("蒸馏窗口未开放", r["reason"])

    def test_compress_llm_unavailable(self):
        """LLM 不可用时 compress 返回不可用提示。"""
        from cerebrate.config import config
        config.evolution_window_enabled = False  # 关闭窗口限制
        self.api.scene_ingest(
            {"session_id": "s2", "events": [{"kind": "msg", "text": "x"}]})
        r = self.api.scene_compress({"session_id": "s2"})
        # LLM 不可用（conftest 已清 key）→ compressed=False
        self.assertFalse(r["compressed"])
        self.assertIn("LLM", r.get("reason", ""))

    def test_distill_window_gate(self):
        """窗口外 distill 被拦截；force 逃生门可过。"""
        from cerebrate.config import config
        config.evolution_window_enabled = True
        config.evolution_window_start_hour = 0
        config.evolution_window_end_hour = 1
        config.evolution_window_tz_offset_hours = 8
        local_noon_utc = datetime(2026, 8, 7, 12) - timedelta(hours=8)
        with patch("cerebrate.config.datetime", wraps=datetime) as mock_dt:
            mock_dt.now.return_value = local_noon_utc.replace(tzinfo=UTC)
            self.api.scene_ingest(
                {"session_id": "d1", "events": [{"kind": "msg", "text": "x"}]})
            r = self.api.scene_distill({"session_id": "d1"})
            self.assertFalse(r["distilled"])
            self.assertIn("蒸馏窗口未开放", r["reason"])

            # force 逃生门：过窗口 → 但 LLM 不可用 → 返回 LLM 提示
            r2 = self.api.scene_distill(
                {"session_id": "d1", "force": True,
                 "physical_user": "tester"})
            self.assertFalse(r2["distilled"])
            self.assertNotIn("蒸馏窗口未开放", r2.get("reason", ""))

    def test_distill_requires_owner(self):
        """distill 无 physical_user 时返回安全溯源错误（不抛异常）。"""
        from cerebrate.config import config
        config.evolution_window_enabled = False
        self.api.scene_ingest(
            {"session_id": "d2", "events": [{"kind": "msg", "text": "x"}]})
        r = self.api.scene_distill({"session_id": "d2"})
        self.assertFalse(r["distilled"])
        self.assertIn("physical_user", r["reason"])


if __name__ == "__main__":
    unittest.main()

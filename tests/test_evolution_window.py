"""蒸馏窗口自检 — 默认仅本地 0:00-1:00 低谷期运行，其他时间禁止蒸馏

需求（v5.1.1，用户要求）:
  - 蒸馏仅在本地 0:00-1:00（Asia/Macau UTC+8，API 低谷）之间运行
  - 其他时间禁止蒸馏（省钱）
  - scheduler 自动调度 / evolution.evolve(force=False) / 按需蒸馏均受窗口约束
  - force=True（管理员显式）保留逃生门
"""
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cerebrate.config import config, in_evolution_window  # noqa: E402


class EvolutionWindowFunctionTests(unittest.TestCase):
    """in_evolution_window 纯函数测试（注入时间，不依赖当前时刻）"""

    def setUp(self):
        # 恢复默认窗口配置：开启窗口、0-1 点、UTC+8
        config.evolution_window_enabled = True
        config.evolution_window_start_hour = 0
        config.evolution_window_end_hour = 1
        config.evolution_window_tz_offset_hours = 8

    def _local(self, hour: int, minute: int = 0) -> datetime:
        """构造指定本地小时对应的 UTC 时刻（UTC+8 偏移）。"""
        local_naive = datetime(2026, 8, 7, hour, minute)
        utc = local_naive - timedelta(hours=config.evolution_window_tz_offset_hours)
        return utc.replace(tzinfo=UTC)

    def test_in_window_midnight(self):
        """本地 0:00-0:59 在窗口内。"""
        self.assertTrue(in_evolution_window(self._local(0)))
        self.assertTrue(in_evolution_window(self._local(0, 30)))
        self.assertTrue(in_evolution_window(self._local(0, 59)))

    def test_outside_window(self):
        """本地 1:00 及以后、23:00 及以前均不在窗口内。"""
        self.assertFalse(in_evolution_window(self._local(1)))
        self.assertFalse(in_evolution_window(self._local(2)))
        self.assertFalse(in_evolution_window(self._local(8)))
        self.assertFalse(in_evolution_window(self._local(12)))
        self.assertFalse(in_evolution_window(self._local(23)))

    def test_window_disabled_is_open(self):
        """窗口关闭（逃生门）→ 恒为 True。"""
        config.evolution_window_enabled = False
        self.assertTrue(in_evolution_window(self._local(15)))

    def test_custom_window(self):
        """自定义窗口（如 22:00-02:00 跨天）生效。"""
        config.evolution_window_start_hour = 22
        config.evolution_window_end_hour = 2
        self.assertTrue(in_evolution_window(self._local(23)))
        self.assertTrue(in_evolution_window(self._local(1)))
        self.assertFalse(in_evolution_window(self._local(12)))


class EvolutionWindowApiTests(unittest.TestCase):
    """API 层窗口约束测试（scheduler/evolve/按需蒸馏）"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name) / "memory"
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
        import cerebrate.core.embedding as embedding
        embedding._engine = None

        # 开启窗口，并模拟非窗口时刻（本地 12:00）
        config.evolution_window_enabled = True
        config.evolution_window_start_hour = 0
        config.evolution_window_end_hour = 1
        config.evolution_window_tz_offset_hours = 8

        from unittest.mock import patch
        local_noon_utc = datetime(2026, 8, 7, 12) - timedelta(hours=8)
        self._now_patch = patch(
            "cerebrate.config.datetime",
            wraps=datetime,
        )
        self._mock_dt = self._now_patch.start()
        self._mock_dt.now.return_value = local_noon_utc.replace(tzinfo=UTC)

        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self._now_patch.stop()
        if self.api._distill_executor is not None:
            self.api._distill_executor.shutdown(wait=False)
        self._tmp.cleanup()

    def test_evolve_non_force_skipped_outside_window(self):
        """窗口外自动进化（force=False）被跳过。"""
        result = self.api.evolve(force=False)
        self.assertTrue(result.get("skipped"))
        self.assertEqual(result.get("reason"), "outside_evolution_window")

    def test_evolve_force_escape_hatch(self):
        """force=True 逃生门：窗口外仍执行（管理员显式）。"""
        result = self.api.evolve(force=True)
        self.assertFalse(result.get("skipped", False))

    def test_distill_on_demand_rejected_outside_window(self):
        """按需蒸馏（同步）窗口外被拒绝，force 逃生门可过。"""
        r = self.api.distill_knowledge_on_demand({"topic": "xyz-no-memory"})
        self.assertFalse(r["distilled"])
        self.assertIn("蒸馏窗口未开放", r["reason"])

        r2 = self.api.distill_knowledge_on_demand(
            {"topic": "xyz-no-memory", "force": True})
        # force 跳过窗口 → 继续走流程（无相似记忆 → distilled=false 且 reason 是记忆不足）
        self.assertFalse(r2["distilled"])
        self.assertNotIn("蒸馏窗口未开放", r2.get("reason", ""))

    def test_distill_async_rejected_outside_window(self):
        """按需蒸馏（异步）窗口外拒绝入队。"""
        r = self.api.distill({"topic": "xyz-no-memory"})
        self.assertEqual(r["status"], "rejected")
        self.assertIn("蒸馏窗口未开放", r["reason"])

    def test_scheduler_window_uses_unified_function(self):
        """scheduler 窗口判断复用统一函数（本地 0-1 点语义）。"""
        from cerebrate.server.scheduler import CerebrateScheduler
        sch = CerebrateScheduler(self.api)
        # 当前 mock 为本地 12:00（窗口外）
        self.assertFalse(sch._in_evolution_window())


if __name__ == "__main__":
    unittest.main()

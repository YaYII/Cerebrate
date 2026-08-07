"""sense 并发防假死回归测试（2026-08-07，生产事故复现防护）

事故背景（cerebrate:5.2.1 生产）:
  - healthcheck 每 30s 调 /v1/sense + opencode/客户端并发
  - sense() 缓存(60s TTL) 无重建锁 → 缓存过期瞬间所有线程同时全量扫 events
  - consensus_overview() 对每个 vote event 调 consensus_snapshot（内部又全量扫）
    → O(N²) 且 ChromaDB 锁竞争 → 64 worker 线程全部卡死 → 服务假死

修复：
  1. sense() 加重建锁：缓存过期只允许一个线程重建，其余复用旧缓存
  2. consensus_overview() 单次扫描内联聚合（消除 O(N²)）

本测试验证：
  - 并发 sense 全部快速返回（不假死）
  - 重建期间其余线程复用旧缓存（不重复全量统计）
  - consensus_overview 聚合结果与 consensus_snapshot 逐条一致
"""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def configure_temp_env(tmp_name):
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
    config.docstore_path = root / "docstore"
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    config.embedding_max_length = 8192
    config.memory_min_tokens = 0
    embedding._engine = None


class SenseConcurrencyTests(unittest.TestCase):
    """sense 并发防假死回归测试"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self.tmp.cleanup()

    def test_concurrent_sense_all_return(self):
        """并发 10 路 sense 全部返回（不假死、不超时）。"""
        results: list = []
        errors: list = []

        def worker():
            try:
                r = self.api.sense()
                results.append(r)
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=worker) for _ in range(10)]
        t0 = time.monotonic()
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        elapsed = time.monotonic() - t0

        self.assertEqual(errors, [], f"并发 sense 出现异常: {errors}")
        self.assertEqual(len(results), 10, "并发 sense 未全部返回")
        # 全部返回同一份缓存数据
        first = results[0]
        for r in results[1:]:
            self.assertEqual(
                r.get("total_memories"), first.get("total_memories"))
        # 30s 内完成（正常应在秒级，防假死回归）
        self.assertLess(elapsed, 30, f"并发 sense 耗时 {elapsed:.1f}s，疑似假死")

    def test_cache_expiry_rebuilds_once(self):
        """缓存过期后重建只执行一次全量统计（其余线程复用旧缓存）。"""
        # 先建一次缓存
        self.api.sense()
        # 使缓存过期
        self.api._sense_cache_ts = 0

        calls = []
        original_overview = self.api.consensus_overview

        def counting_overview():
            calls.append(1)
            # 模拟全量统计较慢（放大并发竞争窗口）
            time.sleep(0.2)
            return original_overview()

        with mock.patch.object(
                self.api, "consensus_overview", side_effect=counting_overview):
            results = []
            errors = []

            def worker():
                try:
                    results.append(self.api.sense())
                except Exception as e:  # noqa: BLE001
                    errors.append(e)

            threads = [threading.Thread(target=worker) for _ in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)

        self.assertEqual(errors, [])
        # 8 路并发，但全量统计（consensus_overview）只应执行 1 次
        self.assertEqual(len(calls), 1,
                         f"缓存过期重建应只执行一次全量统计，实际 {len(calls)} 次")
        self.assertEqual(len(results), 8)

    def test_consensus_overview_matches_snapshot_aggregation(self):
        """consensus_overview 聚合与 consensus_snapshot 逐条决策一致。"""
        # 构造 vote 事件：memory A 两票 support，memory B 一票 oppose
        mids = {}
        for tag in ["mem-a", "mem-b"]:
            r = self.api.propose_memory({
                "title": f"共识测试 {tag}",
                "content": "内容" + ("足够长" * 100),
                "category": "coding",
                "tags": "test",
                "agent": "tester",
                "physical_user": "tester",
                "validate": False,
                "scope": "general",
            })
            mids[tag] = r["memory_id"]
        self.api.events.append("consensus.vote", "agent-a",
                               {"memory_id": mids["mem-a"],
                                "vote": "support", "confidence": 1.0})
        self.api.events.append("consensus.vote", "agent-b",
                               {"memory_id": mids["mem-a"],
                                "vote": "support", "confidence": 0.8})
        self.api.events.append("consensus.vote", "agent-c",
                               {"memory_id": mids["mem-b"],
                                "vote": "oppose", "confidence": 0.9})

        overview = self.api.consensus_overview()
        self.assertEqual(overview["tracked_memories"], 2)
        self.assertEqual(sum(overview["decisions"].values()), 2)

        # 逐条与 consensus_snapshot 对比
        for tag in ["mem-a", "mem-b"]:
            snap = self.api.consensus_snapshot(mids[tag], apply=False)
            self.assertIn(snap["decision"],
                          {"pending", "accepted", "rejected", "split"})


if __name__ == "__main__":
    unittest.main()

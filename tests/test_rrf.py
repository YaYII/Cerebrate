"""RRF 融合检索自检 — Reciprocal Rank Fusion（借鉴 TencentDB Agent Memory）

需求（v5.6 借鉴点）:
  - FTS5 精确关键词召回 + ChromaDB 向量语义召回，按 1/(k+rank) 融合
  - 双路同时命中的记忆排在前列（hybrid 标记）
  - 单一来源命中不丢失；结果按 RRF 总分降序
  - limit 生效；空输入返回空
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cerebrate.core.rrf import reciprocal_rank_fusion  # noqa: E402


class RRFTests(unittest.TestCase):
    """RRF 纯函数测试（不依赖存储/嵌入）"""

    def test_hybrid_double_hit_ranks_first(self):
        """双路命中（同一 memory_id 在 fts+vector 都出现）应排在单路命中之前。"""
        fts = [{"memory_id": "a", "title": "A"}, {"memory_id": "b", "title": "B"}]
        vec = [{"memory_id": "b", "title": "B"}, {"memory_id": "c", "title": "C"}]
        out = reciprocal_rank_fusion([fts, vec], limit=10)
        self.assertEqual(out[0]["memory_id"], "b")
        self.assertEqual(out[0]["source"], "hybrid")
        self.assertGreater(out[0]["rrf_score"], out[1]["rrf_score"])

    def test_single_source_not_lost(self):
        """只在向量路出现的记忆也要进结果，不能因 fts 无命中而丢失。"""
        fts = [{"memory_id": "a", "title": "A"}]
        vec = [{"memory_id": "x", "title": "X"}]
        out = reciprocal_rank_fusion([fts, vec], limit=10)
        mids = {r["memory_id"] for r in out}
        self.assertIn("a", mids)
        self.assertIn("x", mids)

    def test_limit(self):
        """limit 截断生效。"""
        fts = [{"memory_id": f"f{i}", "title": f"F{i}"} for i in range(10)]
        vec = [{"memory_id": f"v{i}", "title": f"V{i}"} for i in range(10)]
        out = reciprocal_rank_fusion([fts, vec], limit=3)
        self.assertLessEqual(len(out), 3)

    def test_empty_inputs(self):
        """空输入返回空列表，不抛异常。"""
        self.assertEqual(reciprocal_rank_fusion([[], []], limit=10), [])
        self.assertEqual(reciprocal_rank_fusion([], limit=10), [])

    def test_k_constant_affects_weight(self):
        """k 越大，排名差异影响越小（前几名分差收窄），但顺序不变。"""
        fts = [{"memory_id": "a", "title": "A"}, {"memory_id": "b", "title": "B"}]
        out_small_k = reciprocal_rank_fusion([fts, []], k=10, limit=10)
        out_large_k = reciprocal_rank_fusion([fts, []], k=200, limit=10)
        self.assertEqual(out_small_k[0]["memory_id"], "a")
        self.assertEqual(out_large_k[0]["memory_id"], "a")


if __name__ == "__main__":
    unittest.main()

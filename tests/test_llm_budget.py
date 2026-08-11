"""LLM 消费预算控制测试（v5.2.2）— 每日额度，超出自动关闭 LLM 能力。

需求（2026-08-11，用户要求）:
  - 每天 LLM 消费额度 1 元（可配），超出自动关闭 LLM（防钱包被攻击）
  - 记账来自每次调用的 usage（token → 单价换算），本地持久化
  - 跨天自动重置；预算 0 = 完全禁止；负值 = 不限制
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

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
    # 预算配置（测试默认 1 元，官方 deepseek-v4-flash 单价）
    config.llm_daily_budget_yuan = 1.0
    config.llm_input_price_per_m = 1.0
    config.llm_output_price_per_m = 2.0
    config.llm_cached_input_price_per_m = 0.02


class LLMBudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.core.llm_budget import LLMBudget
        root = Path(self.tmp.name) / "memory"
        self.budget = LLMBudget(path=root / "llm_budget.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_record_accumulates_cost(self):
        """记账：token × 单价换算正确累加。"""
        # 输入 500K token × 1 元/M + 输出 100K × 2 元/M = 0.5 + 0.2 = 0.7 元
        snap = self.budget.record(prompt_tokens=500_000, completion_tokens=100_000)
        self.assertAlmostEqual(snap["cost"], 0.7, places=4)
        self.assertEqual(snap["calls"], 1)
        self.assertFalse(snap["exceeded"])
        self.assertAlmostEqual(snap["remaining"], 0.3, places=4)

    def test_exceeded_after_budget(self):
        """累计超过 1 元 → exceeded=True。"""
        self.budget.record(prompt_tokens=600_000, completion_tokens=200_000)  # 1.0 元
        snap = self.budget.record(prompt_tokens=100_000)  # +0.1 元
        self.assertTrue(snap["exceeded"])
        self.assertEqual(snap["remaining"], 0.0)

    def test_cross_day_reset(self):
        """跨天自动重置（模拟账本日期为昨天）。"""
        self.budget.record(prompt_tokens=2_000_000)  # 2 元，已超
        self.assertTrue(self.budget.exceeded())
        # 把账本日期改为昨天 → 下次访问应视为新的一天
        import json
        data = json.loads(self.budget.path.read_text(encoding="utf-8"))
        data["date"] = "2000-01-01"
        self.budget.path.write_text(
            json.dumps(data), encoding="utf-8")
        # 重新加载实例（内存 _data 来自文件，日期为昨天 → 触发跨天重置）
        from cerebrate.core.llm_budget import LLMBudget
        b2 = LLMBudget(path=self.budget.path)
        self.assertFalse(b2.exceeded())
        self.assertEqual(b2.today()["cost"], 0.0)

    def test_budget_zero_means_disabled(self):
        """预算 0 = 完全禁止 LLM。"""
        from cerebrate.core.llm_budget import LLMBudget
        root = Path(self.tmp.name) / "memory"
        b = LLMBudget(path=root / "b0.json", daily_budget=0.0)
        self.assertTrue(b.exceeded())

    def test_budget_negative_means_unlimited(self):
        """负值预算 = 不限制。"""
        from cerebrate.core.llm_budget import LLMBudget
        root = Path(self.tmp.name) / "memory"
        b = LLMBudget(path=root / "bneg.json", daily_budget=-1.0)
        b.record(prompt_tokens=10_000_000)
        self.assertFalse(b.exceeded())

    def test_record_usage_openai_style(self):
        """_record_usage 从 openai/deepseek 响应结构记账。"""
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        usage = SimpleNamespace(
            prompt_tokens=100_000,
            completion_tokens=50_000,
            prompt_tokens_details=SimpleNamespace(cached_tokens=10_000))
        resp = SimpleNamespace(usage=usage)
        llm._record_usage(resp)
        snap = llm.budget.today()
        self.assertAlmostEqual(
            snap["cost"],
            (100_000 * 1.0 + 50_000 * 2.0 + 10_000 * 0.02) / 1_000_000,
            places=5)
        self.assertEqual(snap["tokens"]["cached"], 10_000)

    def test_record_usage_anthropic_style(self):
        """_record_usage 从 anthropic 响应结构记账。"""
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        llm._provider = "anthropic"
        usage = SimpleNamespace(
            input_tokens=100_000, output_tokens=20_000,
            cache_read_input_tokens=5_000, cache_creation_input_tokens=3_000)
        llm._record_usage(SimpleNamespace(usage=usage))
        snap = llm.budget.today()
        self.assertEqual(snap["tokens"]["input"], 100_000)
        self.assertEqual(snap["tokens"]["cached"], 8_000)

    def test_is_available_gated_by_budget(self):
        """超预算后 CerebrateLLM.is_available() 返回 False。"""
        from cerebrate.brain.llm import CerebrateLLM
        os.environ["DEEPSEEK_API_KEY"] = "test-key"
        try:
            llm = CerebrateLLM()
            llm._available = None  # 强制重新判断 key
            self.assertTrue(llm.is_available())
            # 记账超过预算
            llm.budget.record(prompt_tokens=2_000_000)
            self.assertTrue(llm.budget.exceeded())
            self.assertFalse(llm.is_available())
        finally:
            os.environ.pop("DEEPSEEK_API_KEY", None)


if __name__ == "__main__":
    unittest.main()

"""结构化字段自检 — observation_type / facts / concepts（对齐 claude-mem observation）

需求（v5.3 Phase 4）:
  - observation_type: 由 category 规则推导（debugging→bugfix, architecture→decision...）
  - concepts: tags + category + 标题关键词规则提取
  - facts: 从 solution/problem_solved 规则提取
  - 索引层展示 observation_type + concepts，让 agent 只看标题/类型即可判断
  - LLM 语义压缩标题：规则保底（截断），LLM 可用时增强
"""
import sys
import tempfile
import unittest
from pathlib import Path

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
    config.title_compress_enabled = False
    config.structured_enrich_enabled = False
    embedding._engine = None


class StructuredFieldsTests(unittest.TestCase):
    """结构化字段提取与索引展示测试"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.config import config
        from cerebrate.memory.swarm import SwarmMemory
        self.swarm = SwarmMemory(config.swarm_path)

    def tearDown(self):
        self.tmp.cleanup()

    def _share(self, title, content, category="coding", tags=None, **kwargs):
        kwargs.setdefault("source_agent", "tester")
        return self.swarm.share(title=title, content=content,
                                category=category, tags=tags or ["test"],
                                **kwargs)

    def test_observation_type_mapping_from_category(self):
        from cerebrate.memory.swarm import observation_type_for
        self.assertEqual(observation_type_for("debugging"), "bugfix")
        self.assertEqual(observation_type_for("architecture"), "decision")
        self.assertEqual(observation_type_for("refactor"), "refactor")
        self.assertEqual(observation_type_for("security"), "gotcha")
        self.assertEqual(observation_type_for("performance"), "optimization")
        self.assertEqual(observation_type_for("unknown-cat"), "discovery")

    def test_observation_type_persisted_and_in_index(self):
        self._share("调试问题记忆", "调试问题内容",
                    category="debugging", tags=["auth", "token"])
        index = self.swarm.query("调试问题", index_only=True)
        self.assertEqual(len(index), 1)
        self.assertEqual(index[0]["observation_type"], "bugfix")

    def test_concepts_from_tags_category_title(self):
        self._share("Docker 部署优化", "Docker 部署优化内容",
                    category="devops", tags=["docker", "ci"])
        index = self.swarm.query("Docker 部署", index_only=True)
        self.assertEqual(len(index), 1)
        concepts = index[0]["concepts"]
        self.assertIn("docker", concepts)
        self.assertIn("ci", concepts)
        self.assertIn("devops", concepts)

    def test_facts_extracted_from_solution(self):
        self._share("缓存问题修复", "缓存问题内容",
                    category="debugging", tags=["cache"],
                    solution="设置短过期时间；加随机抖动防止雪崩。",
                    problem_solved="缓存雪崩导致接口超时")
        mem = self.swarm.get_memory(
            self.swarm.query("缓存问题修复", index_only=True)[0]["memory_id"])
        self.assertIsInstance(mem.get("facts"), list)
        self.assertGreaterEqual(len(mem["facts"]), 1)
        self.assertTrue(any("抖动" in f for f in mem["facts"]))

    def test_detail_view_contains_structured_fields(self):
        self._share("结构化字段详情", "详情视图应包含 observation_type/concepts/facts",
                    category="architecture", tags=["design"])
        mid = self.swarm.query("结构化字段详情", index_only=True)[0]["memory_id"]
        mem = self.swarm.get_memory(mid)
        self.assertEqual(mem["observation_type"], "decision")
        self.assertIn("design", mem["concepts"])

    def test_title_compress_rule_fallback(self):
        from cerebrate.brain.llm import CerebrateLLM
        llm = CerebrateLLM()
        # 无 API key 环境走规则保底：空标题从内容推导
        title = llm.compress_title("", "第一行就是标题来源内容")
        self.assertTrue(title)
        # 过长标题截断
        long_title = "这是一个非常非常长的标题用来测试截断逻辑" * 5
        compressed = llm.compress_title(long_title)
        self.assertLessEqual(len(compressed), 61)

    def test_explicit_observation_type_override(self):
        self._share("显式指定类型", "显式 observation_type 应覆盖规则推导",
                    category="coding", tags=["x"], observation_type="refactor")
        index = self.swarm.query("显式指定类型", index_only=True)
        self.assertEqual(index[0]["observation_type"], "refactor")


if __name__ == "__main__":
    unittest.main()

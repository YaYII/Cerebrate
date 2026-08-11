"""进化防护自检（v5.2.2）— 防止「全量蒸馏」LLM 费用爆炸。

需求（2026-08-11，用户提出）:
  - 2.1 万条分块记录（doc_group_id / total_chunks>1 / is_parent）不参与蒸馏与聚类
  - 单次 evolve 蒸馏主题组有上限（默认 20，按组复用总量取 top N）
  - 每组参与蒸馏的记忆数有上限（默认 30，按复用排序取 top N）

覆盖:
  - chunk / parent 记录在 _distill_and_persist 中被跳过
  - 组上限：超过 max_groups 的主题只蒸馏 top N
  - 组内上限：大组只取 top N 条（按 reuse_count 排序）
"""
import sys
import tempfile
import unittest
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


def make_doc(topic: str) -> dict:
    """构造 LLM 蒸馏返回的最小合法文档。"""
    return {
        "meta": {"title": f"[测试蒸馏] {topic}", "version": "1.0.0",
                 "source_count": 2, "total_reuse": 3, "confidence": 0.9},
        "abstract": "这是测试摘要。",
        "concept_layer": {"concepts": [{
            "term": "核心概念", "definition": "概念定义", "evidence_level": "A",
            "refs": [1]}]},
        "conclusion": "测试结论。",
    }


class EvolutionGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.config import config
        self._orig_max_groups = config.evolution_max_distill_groups
        self._orig_max_mems = config.evolution_max_mems_per_group
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        from cerebrate.config import config
        config.evolution_max_distill_groups = self._orig_max_groups
        config.evolution_max_mems_per_group = self._orig_max_mems
        self.tmp.cleanup()

    def _engine(self):
        from cerebrate.config import config
        from cerebrate.memory.evolution import EvolutionEngine
        return EvolutionEngine(config.evolution_path, self.api.mm)

    def _share(self, title, content, tags, reuse=0, **extra):
        """写一条记忆（复用次数可在元数据层面体现）。"""
        mid = self.api.mm.swarm.share(
            title=title, content=content, category="coding",
            tags=tags, source_agent="guard-test",
            problem_solved="测试问题", solution="测试方案", **extra)
        # 直接改元数据设置 reuse_count（share 默认 0）
        item = self.api.mm.swarm._store.get(mid)
        if item and reuse:
            meta = item["metadata"]
            meta["reuse_count"] = reuse
            self.api.mm.swarm._store.upsert(
                mid, f"{meta.get('title','')}\n{content}", meta)
        return mid

    def _chunk_record(self, doc_group_id: str, tags: str) -> str:
        """写入一条模拟分块记录（doc_group_id + total_chunks>1）。"""
        mid = self.api.mm.swarm.share(
            title="分块片段", content="分块片段内容",
            category="distilled_skill", tags=tags,
            source_agent="guard-test",
            problem_solved="", solution="")
        item = self.api.mm.swarm._store.get(mid)
        meta = item["metadata"]
        meta["doc_group_id"] = doc_group_id
        meta["total_chunks"] = 5
        meta["life_stage"] = "verified_skill"
        self.api.mm.swarm._store.upsert(
            mid, "分块片段内容", meta)
        return mid

    def test_chunk_records_skipped_in_distill(self):
        """chunk / parent 记录不参与蒸馏：LLM 只收到普通记忆。"""
        from cerebrate.config import config
        config.evolution_max_distill_groups = 10
        config.evolution_max_mems_per_group = 10
        # 2 条普通记忆 + 3 条 chunk（同 tag）
        self._share("普通记忆 A", "普通内容 A", ["guard-skip"], reuse=2)
        self._share("普通记忆 B", "普通内容 B", ["guard-skip"], reuse=1)
        self._chunk_record("doc-1", "guard-skip, verified_skill")
        self._chunk_record("doc-1", "guard-skip, verified_skill")
        self._chunk_record("doc-2", "guard-skip, verified_skill")

        from cerebrate.memory.evolution import EvolutionEngine
        calls = []
        with patch("cerebrate.memory.evolution.CerebrateLLM") as mock_cls:
            mock = mock_cls.return_value
            mock.is_available.return_value = True
            def _fake_distill(mems, topic):
                calls.append([m.get("memory_id") for m in mems])
                return make_doc(topic)
            mock.distill_knowledge.side_effect = _fake_distill
            engine = EvolutionEngine(config.evolution_path, self.api.mm)
            created = engine._distill_and_persist()

        self.assertEqual(created, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0]), 2)  # 只有 2 条普通记忆，chunk 被跳过

    def test_max_groups_limit(self):
        """超过 max_groups 的主题只蒸馏 top N（按组复用总量排序）。"""
        from cerebrate.config import config
        config.evolution_max_distill_groups = 2
        config.evolution_max_mems_per_group = 10
        # 3 个主题：guard-a(高复用) / guard-b(中) / guard-c(低)
        self._share("A1", "内容 A1", ["guard-a"], reuse=10)
        self._share("A2", "内容 A2", ["guard-a"], reuse=10)
        self._share("B1", "内容 B1", ["guard-b"], reuse=5)
        self._share("B2", "内容 B2", ["guard-b"], reuse=5)
        self._share("C1", "内容 C1", ["guard-c"], reuse=1)
        self._share("C2", "内容 C2", ["guard-c"], reuse=1)

        from cerebrate.config import config as cfg
        from cerebrate.memory.evolution import EvolutionEngine
        topics = []
        with patch("cerebrate.memory.evolution.CerebrateLLM") as mock_cls:
            mock = mock_cls.return_value
            mock.is_available.return_value = True
            def _fake_distill(mems, topic):
                topics.append(topic)
                return make_doc(topic)
            mock.distill_knowledge.side_effect = _fake_distill
            engine = EvolutionEngine(cfg.evolution_path, self.api.mm)
            engine._distill_and_persist()

        self.assertLessEqual(len(topics), 2)
        self.assertNotIn("guard-c", topics)  # 低复用主题被截断

    def test_max_mems_per_group(self):
        """大组只取 top N 条（按 reuse_count 排序）。"""
        from cerebrate.config import config
        config.evolution_max_distill_groups = 10
        config.evolution_max_mems_per_group = 2
        # 5 条同主题记忆，复用分别为 1..5
        for i in range(5):
            self._share(f"G{i}", f"内容 G{i}", ["guard-mems"], reuse=i + 1)

        from cerebrate.memory.evolution import EvolutionEngine
        got = []
        with patch("cerebrate.memory.evolution.CerebrateLLM") as mock_cls:
            mock = mock_cls.return_value
            mock.is_available.return_value = True
            def _fake_distill(mems, topic):
                got.append([int(m.get("reuse_count", 0)) for m in mems])
                return make_doc(topic)
            mock.distill_knowledge.side_effect = _fake_distill
            engine = EvolutionEngine(config.evolution_path, self.api.mm)
            engine._distill_and_persist()

        self.assertEqual(len(got), 1)
        self.assertEqual(sorted(got[0], reverse=True), [5, 4])  # 只取 top2


if __name__ == "__main__":
    unittest.main()

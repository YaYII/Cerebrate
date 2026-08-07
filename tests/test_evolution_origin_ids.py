"""进化引擎 origin_ids 类型兼容自检

需求（2026-08-07 修复）:
  - 分块聚合记忆的 origin_ids 可能是 list（_item_to_dict _safe_split 产物）
  - evolution 蒸馏时对 origin_ids 调用 .split(",") 会抛
    'list' object has no attribute 'split' → 自动进化崩溃
  - 修复：str/list 双类型兼容，蒸馏不中断
"""
import sys
import tempfile
import unittest
from pathlib import Path

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


class EvolutionOriginIdsTests(unittest.TestCase):
    """蒸馏收集 origin_ids 时 str/list 双类型不崩溃"""

    def _collect_oids(self, origin_ids):
        """复刻 evolution._distill_and_persist 的收集逻辑（修复后）。"""
        all_origin_ids = set()
        _raw_oids = origin_ids or []
        oids = (_raw_oids.split(",") if isinstance(_raw_oids, str)
                else list(_raw_oids))
        all_origin_ids.update(o for o in oids if o)
        return all_origin_ids

    def test_str_origin_ids(self):
        self.assertEqual(
            self._collect_oids("abc,def"), {"abc", "def"})

    def test_list_origin_ids(self):
        self.assertEqual(
            self._collect_oids(["abc", "def"]), {"abc", "def"})

    def test_empty_variants(self):
        self.assertEqual(self._collect_oids(None), set())
        self.assertEqual(self._collect_oids(""), set())
        self.assertEqual(self._collect_oids([]), set())

    def test_evolve_with_list_origin_ids_no_crash(self):
        """端到端：写入带 list origin_ids 的分块记忆，蒸馏不崩溃。"""
        self._tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self._tmp.name)
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()
        try:
            # 写入两条同主题记忆（list origin_ids 经由分块聚合路径产生）
            api.propose_memory({
                "title": "技能: origin 类型兼容 A",
                "content": "测试内容 A：" + "分块" * 400,
                "category": "skill",
                "tags": "origin-compat-test",
                "problem": "",
                "solution": "",
                "agent": "codex",
                "physical_user": "test-user",
                "validate": False,
            })
            api.propose_memory({
                "title": "技能: origin 类型兼容 B",
                "content": "测试内容 B：" + "分块" * 400,
                "category": "skill",
                "tags": "origin-compat-test",
                "problem": "",
                "solution": "",
                "agent": "codex",
                "physical_user": "test-user",
                "validate": False,
            })
            # 不抛异常即通过（LLM 不可用回退模板蒸馏）
            api.evolve(force=True)
        finally:
            self._tmp.cleanup()


if __name__ == "__main__":
    unittest.main()

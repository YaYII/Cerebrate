"""记忆分类自检 — 通用记忆(scope=general) / 项目记忆(scope=project) 隔离

需求（项目升级）:
  - 通用记忆只能查询到通用记忆，绝不混入项目记忆
  - 项目记忆可以查询到该项目记忆 + 通用记忆
  - 记忆写入时自动推导 scope，也支持显式指定
  - 旧数据（无 scope 字段）按 project_id 兼容推导
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
    embedding._engine = None


class MemoryScopeTests(unittest.TestCase):
    """SwarmMemory scope 分类隔离测试"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.memory.swarm import SwarmMemory
        from cerebrate.config import config
        self.swarm = SwarmMemory(config.swarm_path)

    def tearDown(self):
        self.tmp.cleanup()

    def _share(self, title, content, **kwargs):
        return self.swarm.share(
            title=title, content=content, category="coding",
            tags=["test"], source_agent="scope-test", **kwargs)

    def test_auto_scope_general_when_no_project_id(self):
        """未传 project_id 时自动推导为通用记忆 scope=general"""
        mid = self._share("通用经验", "不指定项目，应自动归为通用记忆")
        meta = self.swarm._store.get(mid)["metadata"]
        self.assertEqual(meta.get("scope"), "general")
        self.assertEqual(meta.get("project_id"), "")

    def test_auto_scope_project_when_project_id_given(self):
        """传 project_id 时自动推导为项目记忆 scope=project"""
        mid = self._share("项目经验", "指定项目，应为项目记忆", project_id="proj-alpha")
        meta = self.swarm._store.get(mid)["metadata"]
        self.assertEqual(meta.get("scope"), "project")
        self.assertEqual(meta.get("project_id"), "proj-alpha")

    def test_explicit_scope_general_forces_general(self):
        """显式 scope=general 强制通用（即使传入 project_id 也忽略）"""
        mid = self._share("强制通用", "显式声明通用，不应带项目",
                          project_id="proj-alpha", scope="general")
        meta = self.swarm._store.get(mid)["metadata"]
        self.assertEqual(meta.get("scope"), "general")
        self.assertEqual(meta.get("project_id"), "")

    def test_explicit_scope_project_keeps_project(self):
        """显式 scope=project 且带 project_id 保持项目记忆"""
        mid = self._share("显式项目", "显式声明项目记忆",
                          project_id="proj-beta", scope="project")
        meta = self.swarm._store.get(mid)["metadata"]
        self.assertEqual(meta.get("scope"), "project")
        self.assertEqual(meta.get("project_id"), "proj-beta")

    def test_scope_project_without_project_id_falls_back_to_general(self):
        """显式 scope=project 但无可用项目 ID → 降级为通用记忆"""
        from cerebrate.config import config
        old = config.current_project_id
        config.current_project_id = ""
        try:
            mid = self._share("无项目降级", "没有项目 ID，应降级为通用",
                              scope="project")
            meta = self.swarm._store.get(mid)["metadata"]
            self.assertEqual(meta.get("scope"), "general")
            self.assertEqual(meta.get("project_id"), "")
        finally:
            config.current_project_id = old

    def test_general_query_only_returns_general(self):
        """通用查询（不传 project_id）只返回通用记忆，绝不返回项目记忆"""
        self._share("通用A", "这是通用记忆 A", scope="general")
        self._share("通用B", "这是通用记忆 B", scope="general")
        self._share("项目X", "这是项目 X 的记忆", project_id="proj-x")
        self._share("项目Y", "这是项目 Y 的记忆", project_id="proj-y")

        results = self.swarm.query("这是通用记忆")
        self.assertGreater(len(results), 0, "通用记忆应能查到")
        for r in results:
            self.assertEqual(r.get("scope"), "general",
                             f"通用查询不应返回项目记忆: {r.get('title')}")

    def test_project_query_returns_project_plus_general(self):
        """项目查询返回该项目记忆 + 通用记忆"""
        self._share("通用C", "这是通用记忆 C", scope="general")
        self._share("项目X1", "这是项目 X 的专属记忆一", project_id="proj-x")
        self._share("项目X2", "这是项目 X 的专属记忆二", project_id="proj-x")
        self._share("项目Y", "这是项目 Y 的专属记忆", project_id="proj-y")

        results = self.swarm.query(
            "专属记忆", project_id="proj-x", scope="project")
        titles = {r.get("title") for r in results}
        self.assertIn("项目X1", titles, "项目查询应返回项目 X 的记忆")
        self.assertIn("项目X2", titles, "项目查询应返回项目 X 的记忆")
        self.assertNotIn("项目Y", titles, "项目查询不应返回其他项目记忆")
        # 项目查询可包含通用记忆
        general = [r for r in results if r.get("scope") == "general"]
        self.assertGreater(len(general), 0, "项目查询应可包含通用记忆")

    def test_scope_all_returns_everything(self):
        """scope=all 跨项目全量返回（进化/管理用）"""
        self._share("通用D", "通用记忆 D", scope="general")
        self._share("项目Z", "项目 Z 的记忆", project_id="proj-z")

        results = self.swarm.query("记忆", scope="all")
        self.assertGreaterEqual(len(results), 2,
                                "scope=all 应返回通用+项目全部记忆")

    def test_legacy_data_without_scope_inferred(self):
        """旧数据无 scope 字段时按 project_id 兼容推导"""
        from cerebrate.memory.swarm import SwarmMemory
        mid = self._share("旧数据通用", "旧通用记忆", project_id="")
        item = self.swarm._store.get(mid)
        meta = item["metadata"]
        # 模拟旧数据：删除 scope 字段
        meta.pop("scope", None)
        self.swarm._store.upsert(mid, item["document"], meta)

        results = self.swarm.query("旧通用记忆")
        self.assertEqual(len(results), 1, "旧通用记忆应能被通用查询命中")
        self.assertEqual(results[0].get("scope"), "general",
                         "旧数据无 scope 应按 project_id 推导为 general")

    def test_scope_counts(self):
        """scope 统计：通用/项目/按项目分布"""
        self._share("通用E", "通用记忆 E", scope="general")
        self._share("通用F", "通用记忆 F", scope="general")
        self._share("项目P1", "项目 P 记忆", project_id="proj-p")
        self._share("项目P2", "项目 P 记忆", project_id="proj-p")
        self._share("项目Q", "项目 Q 记忆", project_id="proj-q")

        counts = self.swarm.scope_counts()
        self.assertGreaterEqual(counts["general"], 2)
        self.assertGreaterEqual(counts["project"], 3)
        self.assertIn("proj-p", counts["by_project"])
        self.assertIn("proj-q", counts["by_project"])


class KnowledgeScopeTests(unittest.TestCase):
    """KnowledgeBase scope 分类隔离测试"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.memory.knowledge import KnowledgeBase
        from cerebrate.config import config
        self.kb = KnowledgeBase(config.knowledge_path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_store_and_lookup_scope(self):
        self.kb.store("通用知识", "跨项目的通用最佳实践", "test",
                      ["best-practice"], project_id="", scope="general")
        self.kb.store("项目知识", "本项目特有规范", "test",
                      ["spec"], project_id="proj-spec", scope="project")

        general = self.kb.lookup("最佳实践")
        for r in general:
            self.assertEqual(r.get("scope"), "general")
        self.assertEqual(len(general), 1,
                         "通用查询只返回通用知识")

        project = self.kb.lookup("规范", project_id="proj-spec", scope="project")
        self.assertGreater(len(project), 0, "项目查询应命中项目知识")
        for r in project:
            self.assertIn(r.get("project_id"), {"proj-spec", ""})


if __name__ == "__main__":
    unittest.main()

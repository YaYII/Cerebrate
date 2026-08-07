"""Loadout 装配自检 — 用户级记忆装配（借鉴 TencentDB Agent Memory Loadout）

需求（v5.2 借鉴点）:
  - 用户可设置装配（绑定项目/偏好 scope/绑定标签）
  - 检索时自动应用：未显式传参用装配值，显式传参不覆盖
  - 无用户/无装配 → 检索行为不变
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


class LoadoutTests(unittest.TestCase):
    """Loadout 装配测试"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self._tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self._tmp.cleanup()

    def test_set_get_roundtrip(self):
        r = self.api.loadout_set({
            "_current_user": "alice",
            "bound_projects": ["cerebrate", "ihm-backend"],
            "preferred_scope": "project",
            "bound_tags": ["skill", "rrf"],
        })
        self.assertEqual(len(r["loadout"]["bound_projects"]), 2)

        g = self.api.loadout_get({"user": "alice"})
        self.assertEqual(g["loadout"]["preferred_scope"], "project")
        self.assertEqual(g["loadout"]["bound_tags"], ["skill", "rrf"])

    def test_apply_defaults(self):
        """未显式传参时用装配值。"""
        self.api.loadout_set({
            "_current_user": "alice",
            "bound_projects": ["cerebrate"],
            "preferred_scope": "project",
            "bound_tags": ["skill"],
        })
        out = self.api._apply_loadout_defaults(
            {"_current_user": "alice", "query": "test"})
        self.assertEqual(out["project_id"], "cerebrate")
        self.assertEqual(out["scope"], "project")
        self.assertEqual(out["tags"], ["skill"])

    def test_explicit_params_not_overridden(self):
        """显式传参不覆盖（scope=general 保持）。"""
        self.api.loadout_set({
            "_current_user": "alice", "preferred_scope": "project"})
        out = self.api._apply_loadout_defaults(
            {"_current_user": "alice", "query": "test", "scope": "general"})
        self.assertEqual(out["scope"], "general")

    def test_no_user_unchanged(self):
        """无用户 → 检索行为不变。"""
        out = self.api._apply_loadout_defaults({"query": "test"})
        self.assertEqual(out, {"query": "test"})

    def test_loadout_empty_without_config(self):
        """未配置装配 → 空装配。"""
        g = self.api.loadout_get({"user": "nobody"})
        self.assertEqual(g["loadout"]["bound_projects"], [])


if __name__ == "__main__":
    unittest.main()

"""Skill 版本化自检 — appendVersion（借鉴 TencentDB Agent Memory）

需求（v5.2 借鉴点）:
  - 给已有技能记忆追加新版本（v1 → v2 → v3）
  - 幂等：相同内容重复 append 不新增版本
  - 版本历史可读（version/content_hash/updated/author/description）
  - 非技能记忆拒绝版本化
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


class SkillVersionsTests(unittest.TestCase):
    """Skill 版本化端到端测试"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self._tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self._tmp.cleanup()

    def _create_skill(self, body: str) -> str:
        content = f"技能正文：{body}" + ("内容足够长" * 100)
        r = self.api.propose_memory({
            "title": "测试技能", "content": content, "category": "skill",
            "tags": "skill,test", "problem": "", "solution": "",
            "agent": "codex", "physical_user": "tester", "validate": False,
        })
        return r["memory_id"]

    def test_append_versions_and_idempotent(self):
        mid = self._create_skill("v1")
        content_v1 = "版本1正文" + ("长内容" * 50)
        r1 = self.api.skill_append_version(
            {"memory_id": mid, "content": content_v1,
             "description": "首版", "physical_user": "tester"})
        self.assertTrue(r1["appended"])
        self.assertEqual(r1["version"], "1")

        # 幂等：相同内容重复 append
        r_dup = self.api.skill_append_version(
            {"memory_id": mid, "content": content_v1,
             "physical_user": "tester"})
        self.assertFalse(r_dup["appended"])
        self.assertTrue(r_dup["idempotent"])

        # v2
        r2 = self.api.skill_append_version(
            {"memory_id": mid, "content": content_v1 + "V2",
             "description": "第二版", "physical_user": "tester"})
        self.assertEqual(r2["version"], "2")

        # 版本列表
        vers = self.api.skill_versions({"memory_id": mid})
        self.assertEqual(vers["version_count"], 2)
        self.assertEqual(vers["current_version"], "2")
        self.assertEqual(vers["versions"][0]["description"], "首版")
        self.assertEqual(vers["versions"][1]["description"], "第二版")
        self.assertEqual(vers["versions"][1]["author"], "tester")

    def test_non_skill_memory_rejected(self):
        """非技能记忆拒绝版本化。"""
        r = self.api.propose_memory({
            "title": "普通记忆", "content": "普通技术记忆内容" + ("足够长" * 100),
            "category": "coding", "tags": "test", "problem": "",
            "solution": "", "agent": "codex", "physical_user": "tester",
            "validate": False,
        })
        result = self.api.skill_append_version(
            {"memory_id": r["memory_id"], "content": "内容",
             "physical_user": "tester"})
        self.assertFalse(result["appended"])
        self.assertIn("not a skill memory", result["reason"])

    def test_missing_owner_rejected(self):
        """缺少 physical_user 时拒绝（规避篡改）。"""
        mid = self._create_skill("x")
        with self.assertRaises(ValueError):
            self.api.skill_append_version(
                {"memory_id": mid, "content": "内容"})


if __name__ == "__main__":
    unittest.main()

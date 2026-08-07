"""项目级上下文生成测试（Phase 5 第 2 项）。

验证:
  - build 聚合项目记忆 + 通用记忆（scope 隔离，不混入其他项目）
  - 生成文件写入 memory_root/context（绝不写用户项目目录）
  - <cerebrate-context> 标签包裹自动内容
  - read / list 接口
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
    config.fulltext_enabled = True
    embedding._engine = None


class ProjectContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()
        self.api.register_agent({
            "agent_id": "ctx-test",
            "capabilities": ["testing"],
            "physical_user": "tester",
        })

    def tearDown(self):
        self.tmp.cleanup()

    def _seed(self):
        api = self.api
        api.propose_memory({
            "title": "项目A部署经验", "content": "项目A的生产部署步骤",
            "category": "coding", "agent_id": "ctx-test",
            "project_id": "proj-a", "solution": "先构建再部署",
            "validate": False,
        })
        api.propose_memory({
            "title": "项目A踩坑", "content": "项目A的Redis连接失败",
            "category": "debugging", "agent_id": "ctx-test",
            "project_id": "proj-a", "solution": "检查安全组",
            "validate": False,
        })
        api.propose_memory({
            "title": "项目B经验", "content": "项目B的独有经验",
            "category": "coding", "agent_id": "ctx-test",
            "project_id": "proj-b", "validate": False,
        })
        api.propose_memory({
            "title": "通用Docker技巧", "content": "docker compose 常用命令",
            "category": "coding", "agent_id": "ctx-test",
            "scope": "general", "validate": False,
        })

    def test_build_scope_isolation_and_tag_wrap(self):
        """build 聚合项目记忆 + 通用记忆，不混入其他项目，标签包裹。"""
        self._seed()
        result = self.api.project_context({"project": "proj-a", "action": "build"})
        self.assertEqual(result["project_id"], "proj-a")
        self.assertEqual(result["memory_count"], 3)  # 2 项目 + 1 通用
        content = Path(result["path"]).read_text(encoding="utf-8")
        self.assertIn("项目A部署经验", content)
        self.assertIn("项目A踩坑", content)
        self.assertIn("通用Docker技巧", content)
        self.assertNotIn("项目B经验", content)
        self.assertIn('<cerebrate-context project="proj-a">', content)
        self.assertIn("</cerebrate-context>", content)
        # 文件在 memory_root/context 下，而非项目目录
        self.assertTrue(Path(result["path"]).is_relative_to(
            Path(self.tmp.name) / "memory" / "context"))

    def test_read_and_list(self):
        """read 读取已生成文件；list 列出已有项目。"""
        self._seed()
        missing = self.api.project_context({"project": "proj-a", "action": "read"})
        self.assertFalse(missing["found"])
        self.api.project_context({"project": "proj-a", "action": "build"})
        found = self.api.project_context({"project": "proj-a", "action": "read"})
        self.assertTrue(found["found"])
        self.assertIn("项目A部署经验", found["content"])
        listing = self.api.project_context({"action": "list"})
        self.assertIn("proj-a", listing["projects"])


if __name__ == "__main__":
    unittest.main()

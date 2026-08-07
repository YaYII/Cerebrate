"""知识库 FTS5 全文索引测试（v5.3 遗留项：knowledge.py 接入 FTS5）。

验证:
  - knowledge.store 双写 FTS5（精确关键词：命令/错误码/策略名）
  - knowledge.fulltext_query 命中 / scope 隔离
  - rebuild_fulltext 同时重建 swarm + knowledge
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


class KnowledgeFullTextTests(unittest.TestCase):
    """知识库 FTS5 测试"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.config import config
        from cerebrate.memory.knowledge import KnowledgeBase
        self.kb = KnowledgeBase(config.knowledge_path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_store_dual_writes_fulltext(self):
        """knowledge.store 双写 FTS5，精确关键词可被 fulltext_query 命中。"""
        self.kb.store(
            title="NPM 超时修复",
            content="NPM_CONFIG_TIMEOUT=600000 解决 npm install 超时问题。",
            source="test",
            topics=["npm", "timeout"],
        )
        results = self.kb.fulltext_query("NPM_CONFIG_TIMEOUT")
        self.assertEqual(len(results), 1, "FTS 应精确命中错误码/环境变量名")
        self.assertEqual(results[0]["title"], "NPM 超时修复")
        self.assertEqual(results[0]["source"], "fulltext")
        self.assertEqual(results[0]["scope"], "general")

    def test_scope_isolation_in_knowledge_fts(self):
        """知识库 FTS scope 隔离：通用查询绝不混入项目知识。"""
        self.kb.store(
            title="通用策略",
            content="全局通用配置说明 XYZ_COMMON_TOKEN",
            source="test",
            topics=["general"],
        )
        self.kb.store(
            title="项目 A 策略",
            content="项目 A 私有配置 XYZ_PROJECT_A_TOKEN",
            source="test",
            topics=["project-a"],
            project_id="proj-a",
            scope="project",
        )
        # 不传 scope → 只查通用
        general = self.kb.fulltext_query("XYZ_COMMON_TOKEN")
        self.assertEqual(len(general), 1)
        self.assertEqual(general[0]["scope"], "general")
        # 传 project → 项目 + 通用
        project = self.kb.fulltext_query(
            "XYZ_PROJECT_A_TOKEN", scope="project", project_id="proj-a")
        self.assertEqual(len(project), 1)
        self.assertEqual(project[0]["scope"], "project")
        # 通用查询不得混入项目知识
        leak = self.kb.fulltext_query("XYZ_PROJECT_A_TOKEN")
        self.assertEqual(len(leak), 0, "通用查询绝不返回项目知识")

    def test_rebuild_fulltext_covers_knowledge(self):
        """rebuild_fulltext 同时重建 swarm 记忆与知识库。"""
        from cerebrate.config import config
        from cerebrate.memory.manager import MemoryManager
        from cerebrate.memory.swarm import SwarmMemory

        swarm = SwarmMemory(config.swarm_path)
        swarm.share(
            title="记忆关键词",
            content="MEMORY_UNIQUE_TOKEN_99999",
            category="test",
            tags=[],
            source_agent="test",
        )
        self.kb.store(
            title="知识关键词",
            content="KNOWLEDGE_UNIQUE_TOKEN_88888",
            source="test",
            topics=["test"],
        )
        manager = MemoryManager(
            config.personal_path, config.swarm_path, config.knowledge_path)
        result = manager.rebuild_fulltext()
        self.assertEqual(result["status"], "ok")
        self.assertIn("swarm", result)
        self.assertIn("knowledge", result)
        self.assertEqual(result["knowledge"]["status"], "ok")
        self.assertGreaterEqual(result["knowledge"]["total"], 1)
        # 重建后两条索引都在
        self.assertEqual(len(manager.fulltext_query_swarm("MEMORY_UNIQUE_TOKEN_99999")), 1)


if __name__ == "__main__":
    unittest.main()

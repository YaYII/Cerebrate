"""FTS5 全文索引自检（v5.3 Phase 3，对齐 claude-mem search-architecture）

需求:
  - FTS5 精确关键词命中（错误码/命令/函数名），trigram 支持中文子串
  - scope 隔离贯穿全文检索（通用查询绝不混入项目记忆）
  - /v1/search 支持 hybrid / fts / vector 三种模式
  - 全量重建命令（从 DocStore 补齐旧记忆索引）
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
    config.fulltext_enabled = True
    embedding._engine = None


class FullTextTests(unittest.TestCase):
    """FTS5 全文索引测试"""

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

    def test_english_exact_keyword_match(self):
        self._share("ECONNREFUSED 连接被拒绝",
                    "修复方案：检查端口占用，使用 ss -tlnp 查看。", category="debugging")
        results = self.swarm.fulltext_query("ECONNREFUSED")
        self.assertGreaterEqual(len(results), 1)
        self.assertEqual(results[0]["source"], "fulltext")

    def test_cjk_substring_match(self):
        self._share("缓存雪崩处理", "缓存雪崩导致接口超时，设置短过期时间加随机抖动。")
        results = self.swarm.fulltext_query("缓存雪崩")
        self.assertGreaterEqual(len(results), 1)

    def test_like_fallback_for_short_cjk(self):
        self._share("随机抖动方案", "加随机抖动防止缓存雪崩。")
        results = self.swarm.fulltext_query("抖动")
        self.assertGreaterEqual(len(results), 1)

    def test_scope_isolation_in_fulltext(self):
        self._share("项目专用部署经验", "项目 A 的部署流水线配置",
                    project_id="proj-a", scope="project")
        self._share("通用部署经验", "通用部署流水线配置",
                    project_id="", scope="general")
        # 通用查询绝不混入项目记忆
        general = self.swarm.fulltext_query("部署", scope="general")
        self.assertTrue(all(r["project_id"] == "" for r in general))
        # 项目查询包含项目 + 通用
        project = self.swarm.fulltext_query(
            "部署", scope="project", project_id="proj-a")
        self.assertTrue(any(r["project_id"] == "proj-a" for r in project))

    def test_api_search_hybrid_mode(self):
        from cerebrate.server.api import BrainAPI
        self._share("端口冲突修复方案",
                    "ERROR: port 8080 already in use，使用 lsof -i:8080 查看占用。",
                    category="debugging")
        api = BrainAPI()
        # hybrid：FTS 命中优先
        result = api.search({"query": "port 8080 already in use",
                             "agent_id": "tester", "mode": "hybrid"})
        self.assertGreaterEqual(result["count"], 1)
        self.assertIn("sources", result["retrieval"])
        # fts 模式
        result_fts = api.search({"query": "lsof", "agent_id": "tester", "mode": "fts"})
        self.assertGreaterEqual(result_fts["count"], 1)
        self.assertTrue(all(r["source"] == "fulltext" for r in result_fts["index"]))
        # vector 模式（退化：hash embedding 也可能命中）
        result_vec = api.search({"query": "端口冲突", "agent_id": "tester", "mode": "vector"})
        self.assertIsInstance(result_vec["index"], list)

    def test_rebuild_fulltext_from_docstore(self):
        from cerebrate.server.api import BrainAPI
        self._share("重建前旧记忆", "这条记忆在重建命令执行前已写入 DocStore。")
        api = BrainAPI()
        result = api.rebuild_fulltext()
        self.assertEqual(result["status"], "ok")
        self.assertGreaterEqual(result["total"], 1)
        # 重建后可检索
        found = api.search({"query": "重建前旧记忆", "agent_id": "tester", "mode": "fts"})
        self.assertGreaterEqual(found["count"], 1)

    def test_fts_token_estimate_in_results(self):
        self._share("超长内容 token 估算", "内容" * 100)
        results = self.swarm.fulltext_query("超长内容")
        self.assertGreaterEqual(len(results), 1)
        self.assertGreater(results[0]["token_estimate"], 0)


if __name__ == "__main__":
    unittest.main()

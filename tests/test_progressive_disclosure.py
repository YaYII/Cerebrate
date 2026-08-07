"""渐进式披露自检 — 3 层检索工作流（对齐 claude-mem 设计）

需求（v5.3 Phase 1）:
  - index 层（/v1/search）：只返回紧凑索引（id/标题/类型/评分/token成本），不加载全文
  - timeline 层（/v1/timeline）：围绕 anchor 记忆的时序上下文
  - detail 层（GET /v1/memories/{id}）：按需取完整内容
  - /v1/query 默认索引模式，detail=true 时才返回全文（向后兼容）
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


class ProgressiveDisclosureTests(unittest.TestCase):
    """渐进式披露 3 层检索测试"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.config import config
        from cerebrate.memory.swarm import SwarmMemory
        self.swarm = SwarmMemory(config.swarm_path)

    def tearDown(self):
        self.tmp.cleanup()

    def _share(self, title, content, **kwargs):
        kwargs.setdefault("category", "coding")
        kwargs.setdefault("tags", ["test"])
        kwargs.setdefault("source_agent", "tester")
        return self.swarm.share(title=title, content=content, **kwargs)

    def test_index_only_returns_compact_entries_without_content(self):
        self._share("渐进式披露测试记忆", "这是用于验证渐进式披露索引层的完整内容。"
                     "包含详细的解决方案步骤和注意事项，长度足以触发 token 估算。")
        index = self.swarm.query("渐进式披露", index_only=True)
        self.assertEqual(len(index), 1)
        entry = index[0]
        # 索引层必须包含判断所需的最小字段
        self.assertIn("memory_id", entry)
        self.assertIn("title", entry)
        self.assertIn("score", entry)
        self.assertIn("token_estimate", entry)
        self.assertIn("category", entry)
        self.assertIn("scope", entry)
        # 索引层绝不携带全文
        self.assertNotIn("content", entry)
        self.assertGreater(entry["token_estimate"], 0)

    def test_full_query_still_returns_content(self):
        self._share("完整模式回归测试", "detail 模式必须仍然返回完整内容，保证旧行为不回归。")
        results = self.swarm.query("完整模式回归", index_only=False)
        self.assertEqual(len(results), 1)
        self.assertIn("content", results[0])
        self.assertIn("detail 模式必须仍然返回完整内容", results[0]["content"])

    def test_token_estimate_persisted_on_write(self):
        long_content = "x" * 400
        mid = self._share("长记忆 token 估算", long_content)
        index = self.swarm.query("长记忆 token", index_only=True)
        self.assertEqual(len(index), 1)
        # 统一 core.chunking 中英加权算法：400 个 x = 1 个英文单词 → 2 tokens
        self.assertEqual(index[0]["token_estimate"], 2)

    def test_api_search_returns_index(self):
        from cerebrate.server.api import BrainAPI
        self._share("API search 测试", "通过 API 层调用 search 应返回紧凑索引。")
        api = BrainAPI()
        result = api.search({"query": "API search", "agent_id": "tester"})
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["retrieval"]["layer"], 1)
        self.assertEqual(result["retrieval"]["mode"], "index")
        entry = result["index"][0]
        self.assertNotIn("content", entry)
        self.assertIn("token_estimate", entry)

    def test_api_query_defaults_to_full_detail_mode(self):
        from cerebrate.server.api import BrainAPI
        self._share("默认查询全文模式", "不传 detail 时 query 应保持旧行为返回完整内容。")
        api = BrainAPI()
        result = api.query({"query": "默认查询索引", "agent_id": "tester"})
        self.assertEqual(result["retrieval"]["mode"], "detail")
        self.assertIn("retrieval", result)

    def test_api_query_detail_false_returns_index(self):
        from cerebrate.server.api import BrainAPI
        self._share("显式索引模式", "detail=false 时 query 应只返回紧凑索引。")
        api = BrainAPI()
        result = api.query({"query": "显式索引", "agent_id": "tester", "detail": False})
        self.assertEqual(result["retrieval"]["mode"], "index")
        for m in result["swarm_results"]:
            self.assertNotIn("content", m)

    def test_api_query_detail_mode_returns_content(self):
        from cerebrate.server.api import BrainAPI
        self._share("详情模式查询", "detail=true 时 query 应返回完整内容，旧行为兼容。")
        api = BrainAPI()
        result = api.query({"query": "详情模式", "agent_id": "tester", "detail": True})
        self.assertEqual(result["retrieval"]["mode"], "detail")
        self.assertTrue(result["found"])

    def test_api_timeline_returns_window_around_anchor(self):
        from cerebrate.server.api import BrainAPI
        mid = self._share("时间线锚点记忆", "这条记忆应成为 timeline 的 anchor。")
        api = BrainAPI()
        # 触发一些事件（查询会写 memory.queried 事件）
        api.query({"query": "时间线锚点", "agent_id": "tester"})
        result = api.timeline({"anchor": mid})
        self.assertTrue(result["found"])
        self.assertEqual(result["anchor"], mid)
        self.assertEqual(result["retrieval"]["layer"], 2)
        self.assertIsInstance(result["events"], list)

    def test_api_timeline_query_finds_anchor(self):
        from cerebrate.server.api import BrainAPI
        self._share("时间线自动找锚点", "通过 query 参数自动找 top1 作为 anchor。")
        api = BrainAPI()
        result = api.timeline({"query": "时间线自动找锚点"})
        self.assertTrue(result["found"])
        self.assertTrue(result["anchor"])
        self.assertEqual(result["anchor_title"], "时间线自动找锚点")

    def test_timeline_missing_anchor_returns_found_false(self):
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()
        result = api.timeline({"anchor": "nonexistent-id"})
        self.assertFalse(result["found"])

    def test_sense_returns_recent_index(self):
        """sense 返回最近记忆紧凑索引（含 token 成本）— Phase 5。"""
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()
        api.register_agent({
            "agent_id": "sense-recent",
            "capabilities": ["testing"],
            "physical_user": "tester",
        })
        api.propose_memory({
            "title": "最近记忆甲",
            "content": "第一条最近记忆内容验证。",
            "category": "testing",
            "agent_id": "sense-recent",
            "validate": False,
        })
        api.propose_memory({
            "title": "最近记忆乙",
            "content": "第二条最近记忆内容验证。",
            "category": "testing",
            "agent_id": "sense-recent",
            "validate": False,
        })
        sense = api.sense()
        index = sense.get("recent_index", [])
        self.assertIsInstance(index, list)
        self.assertGreaterEqual(len(index), 2)
        # 紧凑索引：不含 content，含 token 成本
        first = index[0]
        self.assertIn("memory_id", first)
        self.assertIn("title", first)
        self.assertIn("token_estimate", first)
        self.assertNotIn("content", first)
        # 按 created 倒序（最近的在最前）
        titles = [m["title"] for m in index]
        self.assertIn("最近记忆乙", titles)


if __name__ == "__main__":
    unittest.main()

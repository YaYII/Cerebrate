"""MCP 工作流自检（v5.3 Phase 2，对齐 claude-mem 4 工具精简）

需求:
  - 3 层工作流工具存在：cerebrate_search / cerebrate_timeline / cerebrate_detail
  - sense 描述含 3-LAYER WORKFLOW 引导（对齐 important_workflow）
  - 重叠读工具标记 deprecated 提示
  - POST /v1/memories/detail 批量取详情（第 3 层）
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


class McpWorkflowTests(unittest.TestCase):
    """MCP 工作流工具与详情端点测试"""

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

    def test_mcp_tools_include_3layer_workflow(self):
        import cerebrate.mcp as mcp
        names = [t["name"] for t in mcp.TOOLS]
        for required in ("cerebrate_search", "cerebrate_timeline",
                         "cerebrate_detail", "cerebrate_sense",
                         "cerebrate_propose"):
            self.assertIn(required, names)

    def test_sense_description_has_workflow_guidance(self):
        import cerebrate.mcp as mcp
        sense = next(t for t in mcp.TOOLS if t["name"] == "cerebrate_sense")
        desc = sense["description"]
        self.assertIn("3-LAYER WORKFLOW", desc)
        self.assertIn("cerebrate_search", desc)
        self.assertIn("cerebrate_detail", desc)

    def test_overlapping_read_tools_marked_deprecated(self):
        import cerebrate.mcp as mcp
        tools = {t["name"]: t for t in mcp.TOOLS}
        for name in ("cerebrate_query", "cerebrate_knowledge_search",
                     "cerebrate_propose_skill", "cerebrate_propose_lesson"):
            self.assertIn("deprecated", tools[name]["description"])

    def test_project_context_tool_registered(self):
        """cerebrate_project_context 工具存在且含 build/read/list 工作流（Phase 5 第 2 项）。"""
        import cerebrate.mcp as mcp
        tool = next(t for t in mcp.TOOLS if t["name"] == "cerebrate_project_context")
        props = tool["inputSchema"]["properties"]
        self.assertIn("project", props)
        self.assertIn("action", props)
        actions = props["action"]["enum"]
        self.assertIn("build", actions)
        self.assertIn("read", actions)
        self.assertIn("list", actions)

    def test_project_context_via_api(self):
        """MCP 对应的 /v1/project/context 端点：build 后 read 可见。"""
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()
        api.register_agent({
            "agent_id": "mcp-ctx",
            "capabilities": ["testing"],
            "physical_user": "tester",
        })
        api.propose_memory({
            "title": "MCP 上下文测试", "content": "验证 project-context 端点。",
            "category": "testing", "agent_id": "mcp-ctx",
            "project_id": "proj-mcp", "validate": False,
        })
        built = api.project_context({"project": "proj-mcp", "action": "build"})
        self.assertEqual(built["memory_count"], 1)
        read = api.project_context({"project": "proj-mcp", "action": "read"})
        self.assertTrue(read["found"])
        self.assertIn("MCP 上下文测试", read["content"])

    def test_detail_batch_returns_full_memories(self):
        from cerebrate.server.api import BrainAPI
        mid = self._share("批量详情测试", "批量详情应返回完整内容与结构化字段",
                          category="debugging", tags=["batch"],
                          solution="批量接口一次取多条详情。")
        api = BrainAPI()
        result = api.memory_detail({"ids": [mid, "nonexistent-id"]})
        self.assertEqual(len(result["memories"]), 1)
        self.assertEqual(len(result["missing"]), 1)
        mem = result["memories"][0]
        self.assertIn("content", mem)
        self.assertEqual(mem["observation_type"], "bugfix")
        self.assertEqual(result["retrieval"]["layer"], 3)

    def test_search_returns_workflow_next_hint(self):
        from cerebrate.server.api import BrainAPI
        self._share("搜索工作流提示", "search 应返回下一层指引。")
        api = BrainAPI()
        result = api.search({"query": "搜索工作流", "agent_id": "tester"})
        self.assertIn("layer", result["retrieval"])
        self.assertEqual(result["retrieval"]["layer"], 1)
        self.assertIn("next", result["retrieval"])


if __name__ == "__main__":
    unittest.main()

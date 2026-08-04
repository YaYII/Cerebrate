"""灵魂（Soul）机制测试 — 工程化思维行为准则注入

需求（2026-08-04）:
  - 每个接入虫群的 AI 自动获得「工程化思维灵魂」（life_stage=doctrine, scope=general）
  - soul_set: 服务端权威写入口（客户端 propose 不能写 doctrine，本接口绕过白名单）
  - soul_get / doctrines: 读取灵魂
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
    config.title_compress_enabled = False
    config.structured_enrich_enabled = False
    embedding._engine = None


class SoulTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self.tmp.cleanup()

    def test_soul_set_writes_doctrine(self):
        data = self.api.soul_set({
            "title": "工程化思维灵魂（Engineering Soul）",
            "content": "铁律一：证据优先。铁律二：开工前调研。"
                       "铁律三：最小修改。铁律四：验证结果。铁律五：总结与交接。",
            "agent": "tester",
        })
        self.assertEqual(data["life_stage"], "doctrine")
        self.assertEqual(data["scope"], "general")
        mem = self.api.mm.get_swarm_memory(data["memory_id"])
        self.assertIsNotNone(mem)
        self.assertEqual(mem.get("life_stage"), "doctrine")
        self.assertEqual(mem.get("scope"), "general")
        self.assertIn("soul", mem.get("tags") or [])

    def test_soul_get_returns_only_soul_doctrine(self):
        self.api.soul_set({
            "title": "工程化思维灵魂",
            "content": "证据优先，不空谈，测试验证。",
            "agent": "tester",
        })
        data = self.api.soul_get()
        self.assertEqual(data["count"], 1)
        self.assertIn("灵魂", data["souls"][0]["title"])

    def test_doctrines_includes_soul(self):
        self.api.soul_set({
            "title": "工程化思维灵魂",
            "content": "证据优先，不空谈，测试验证。",
            "agent": "tester",
        })
        docs = self.api.doctrines()
        self.assertEqual(docs["count"], 1)
        self.assertEqual(docs["doctrines"][0]["life_stage"], "doctrine")

    def test_client_propose_cannot_write_doctrine(self):
        # 权威规则：客户端 propose 只能写 nutrient|memory，doctrine 会回退
        resp = self.api.propose_memory({
            "title": "尝试写 doctrine",
            "content": "客户端不应能提交 doctrine，应回退为 memory。",
            "category": "coding",
            "agent_id": "tester",
            "physical_user": "tester",
            "life_stage": "doctrine",
        })
        self.assertNotEqual(resp["life_stage"], "doctrine")


if __name__ == "__main__":
    unittest.main()

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

    def test_soul_set_archives_previous(self):
        # 连续写入两次：旧灵魂应被归档（life_stage=doctrine → archived），
        # doctrines/soul_get 只保留当前版本（去重）
        first = self.api.soul_set({
            "title": "工程化思维灵魂 v1",
            "content": "证据优先，不空谈，测试验证。",
            "agent": "tester",
        })
        second = self.api.soul_set({
            "title": "工程化思维灵魂 v2",
            "content": "证据优先，不空谈，测试验证。（v2 更新）",
            "agent": "tester",
        })
        self.assertIn("archived_previous", second)
        self.assertIn(first["memory_id"], second["archived_previous"])
        old = self.api.mm.get_swarm_memory(first["memory_id"])
        self.assertEqual(old.get("life_stage"), "archived")
        # 去重后 soul_get / doctrines 只返回当前版本
        self.assertEqual(self.api.soul_get()["count"], 1)
        self.assertEqual(self.api.doctrines()["count"], 1)
        self.assertEqual(self.api.doctrines()["doctrines"][0]["memory_id"],
                         second["memory_id"])

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

    def test_archived_soul_not_in_search(self):
        # 归档的灵魂不应出现在向量检索中（life_stage=archived 过滤）
        first = self.api.soul_set({
            "title": "工程化思维灵魂旧版",
            "content": "旧的灵魂内容，证据优先，不空谈，测试验证。",
            "agent": "tester",
        })
        self.api.soul_set({
            "title": "工程化思维灵魂新版",
            "content": "新的灵魂内容，证据优先，不空谈，测试验证。",
            "agent": "tester",
        })
        res = self.api.search({
            "query": "工程化思维灵魂旧版", "scope": "all", "limit": 10,
            "agent_id": "tester", "mode": "vector",
        })
        ids = [m.get("memory_id") for m in res.get("index", [])]
        self.assertNotIn(first["memory_id"], ids)

    def test_auto_lesson_dedup(self):
        # 自动经验问题级去重：同标题已存在（非 archived）→ 应跳过
        self.api.propose_memory({
            "title": "[自动经验] 项目架构介绍",
            "content": "项目架构的自动经验提取测试内容，证据优先，不空谈。",
            "category": "coding",
            "agent_id": "tester",
            "physical_user": "tester",
        })
        self.assertTrue(self.api._auto_lesson_exists("[自动经验] 项目架构介绍"))
        self.assertFalse(self.api._auto_lesson_exists("[自动经验] 不存在的标题"))
        # 归档后不再视为存在（可重新提取）
        resp = self.api.search({
            "query": "[自动经验] 项目架构介绍", "scope": "all", "limit": 5,
            "agent_id": "tester", "mode": "fts",
        })
        mid = resp["index"][0]["memory_id"] if resp.get("index") else None
        if mid:
            self.api.mm.swarm.update_lifecycle(mid, "archived")
            self.assertFalse(self.api._auto_lesson_exists("[自动经验] 项目架构介绍"))

    def test_dedup_check_document_dimension(self):
        """去重检查：独立文档维度，同标题多份才算重复；分块不算。"""
        # 两条同标题独立记忆 → 识别为重复
        self.api.propose_memory({
            "title": "去重检查测试文档",
            "content": "这是去重检查的第一份测试文档内容，用于验证独立文档维度统计。",
            "category": "coding",
            "agent_id": "tester",
            "physical_user": "tester",
        })
        self.api.propose_memory({
            "title": "去重检查测试文档",
            "content": "这是去重检查的第二份测试文档内容，标题与第一份相同。",
            "category": "coding",
            "agent_id": "tester",
            "physical_user": "tester",
        })
        res = self.api.dedup_check()
        self.assertGreaterEqual(res["duplicate_groups"], 1)
        group = next((g for g in res["groups"]
                      if g["title"] == "去重检查测试文档"), None)
        self.assertIsNotNone(group)
        self.assertEqual(group["count"], 2)
        self.assertEqual(group["redundant"], 1)
        # 唯一标题不算重复
        self.api.propose_memory({
            "title": "去重检查唯一文档",
            "content": "这份文档标题唯一，不应出现在重复组里。",
            "category": "coding",
            "agent_id": "tester",
            "physical_user": "tester",
        })
        res2 = self.api.dedup_check()
        self.assertNotIn("去重检查唯一文档",
                         [g["title"] for g in res2["groups"]])


if __name__ == "__main__":
    unittest.main()

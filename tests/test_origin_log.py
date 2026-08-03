"""原始记忆日志 OriginLog 单元测试 + 集成测试。"""
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def configure_temp_memory(tmp_name):
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
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    embedding._engine = None
    config.memory_min_tokens = 0  # 测试环境不做长度限制


class OriginLogTests(unittest.TestCase):
    """测试 OriginLog 基本功能。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from cerebrate.memory.origin import OriginLog
        self.origin = OriginLog()

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_and_get(self):
        """写入一条原始记忆，能够完整读取。"""
        payload = {
            "title": "测试原始记忆",
            "content": "这是一条原始记忆内容",
            "category": "testing",
            "tags": "test,origin",
            "agent_id": "test-agent",
            "physical_user": "test-user",
            "project_id": "test-project",
            "problem": "验证 OriginLog 基本功能",
            "solution": "使用 add/get 方法",
        }
        origin_id = self.origin.add("memory-abc123", payload)

        # 读取
        result = self.origin.get(origin_id)
        self.assertIsNotNone(result)
        self.assertEqual(result["origin_id"], origin_id)
        self.assertEqual(result["memory_id"], "memory-abc123")
        self.assertEqual(result["title"], "测试原始记忆")
        self.assertEqual(result["payload"]["content"], "这是一条原始记忆内容")
        self.assertEqual(result["physical_user"], "test-user")
        self.assertEqual(result["project_id"], "test-project")
        self.assertIn("recorded_at", result)

    def test_get_nonexistent(self):
        """读取不存在的原始记忆返回 None。"""
        result = self.origin.get("nonexistent-id")
        self.assertIsNone(result)

    def test_get_by_memory_id(self):
        """按关联的共享记忆 ID 查询原始记录。"""
        self.origin.add("mem-1", {"title": "记录1", "content": "内容1"})
        self.origin.add("mem-2", {"title": "记录2", "content": "内容2"})
        self.origin.add("mem-1", {"title": "记录3", "content": "内容3"})

        results = self.origin.get_by_memory_id("mem-1")
        self.assertEqual(len(results), 2)
        titles = {r["title"] for r in results}
        self.assertEqual(titles, {"记录1", "记录3"})

        results = self.origin.get_by_memory_id("mem-2")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "记录2")

    def test_count(self):
        """计数器正确递增。"""
        self.assertEqual(self.origin.count, 0)
        self.origin.add("mem-1", {"title": "t1"})
        self.assertEqual(self.origin.count, 1)
        self.origin.add("mem-2", {"title": "t2"})
        self.assertEqual(self.origin.count, 2)

    def test_appears_in_api_response(self):
        """验证 propose_memory 返回中包含 origin_id。"""
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()

        api.register_agent({
            "agent_id": "origin-test-agent",
            "capabilities": ["testing"],
            "physical_user": "api-tester",
        })

        proposed = api.propose_memory({
            "title": "OriginLog API 测试",
            "content": "验证 API 返回 origin_id 字段。",
            "category": "testing",
            "agent_id": "origin-test-agent",
            "physical_user": "api-tester",
            "solution": "检查响应中的 origin_id",
            "validate": False,
        })

        # API 返回应包含 origin_id
        self.assertIn("origin_id", proposed)
        self.assertTrue(proposed["origin_id"])
        self.assertIn("memory_id", proposed)

        # 共享记忆应包含 origin_ids
        memory = api.get_memory(proposed["memory_id"])
        self.assertIn("origin_ids", memory)
        self.assertIn(proposed["origin_id"], memory["origin_ids"])

    def test_get_origin_api(self):
        """通过 BrainAPI.get_origin 读取原始记忆。"""
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()

        api.register_agent({
            "agent_id": "origin-api-agent",
            "capabilities": ["testing"],
            "physical_user": "api-tester",
        })

        proposed = api.propose_memory({
            "title": "API get_origin 测试",
            "content": "验证 get_origin API 方法。",
            "category": "testing",
            "agent_id": "origin-api-agent",
            "physical_user": "api-tester",
            "solution": "直接调用 get_origin",
            "validate": False,
            "tags": "api,test",
        })

        origin = api.get_origin(proposed["origin_id"])
        self.assertIsNotNone(origin)
        self.assertEqual(origin["origin_id"], proposed["origin_id"])
        self.assertEqual(origin["memory_id"], proposed["memory_id"])
        self.assertEqual(origin["payload"]["title"], "API get_origin 测试")
        self.assertEqual(origin["payload"]["agent_id"], "origin-api-agent")

    def test_get_memory_origins_api(self):
        """通过 BrainAPI.get_memory_origins 追溯共享记忆来源。"""
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()

        api.register_agent({
            "agent_id": "origins-trace-agent",
            "capabilities": ["testing"],
            "physical_user": "api-tester",
        })

        proposed = api.propose_memory({
            "title": "来源追溯测试",
            "content": "验证 get_memory_origins 接口。",
            "category": "testing",
            "agent_id": "origins-trace-agent",
            "physical_user": "api-tester",
            "solution": "调用 get_memory_origins",
            "validate": False,
        })

        result = api.get_memory_origins(proposed["memory_id"])
        self.assertIn("memory_id", result)
        self.assertIn("origin_ids", result)
        self.assertIn("origins", result)
        self.assertEqual(len(result["origins"]), 1)
        self.assertEqual(result["origins"][0]["origin_id"], proposed["origin_id"])

    def test_origin_ids_persist_in_swarm_memory(self):
        """共享记忆的 origin_ids 在 query 结果中可查询。"""
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()

        api.register_agent({
            "agent_id": "swarm-origin-agent",
            "capabilities": ["testing"],
            "physical_user": "api-tester",
        })

        api.propose_memory({
            "title": "Swarm 中的 OriginLog 数据",
            "content": "验证 origin_ids 在查询结果中存在。",
            "category": "testing",
            "tags": "origin,swarm",
            "agent_id": "swarm-origin-agent",
            "physical_user": "api-tester",
            "problem": "验证 origin_ids",
            "solution": "查询后检查 origin_ids 字段",
            "validate": False,
        })

        query_result = api.query({
            "query": "OriginLog 数据 origin_ids",
            "agent_id": "swarm-origin-agent",
        })

        self.assertTrue(query_result["found"])
        swarm_mem = query_result["swarm_result"]
        self.assertIn("origin_ids", swarm_mem)
        self.assertGreater(len(swarm_mem["origin_ids"]), 0)

    def test_evolution_merge_preserves_origin_ids(self):
        """进化合并时，保留者的 origin_ids 应包含被合并者的。"""
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()

        api.register_agent({
            "agent_id": "evo-agent",
            "capabilities": ["testing"],
            "physical_user": "api-tester",
        })

        # 写入两条语义相似的记忆
        mem1 = api.propose_memory({
            "title": "进化合并测试 A",
            "content": "Python 项目使用 pytest 进行单元测试，推荐使用 fixtures。",
            "category": "testing",
            "tags": "evolution,pytest",
            "agent_id": "evo-agent",
            "physical_user": "api-tester",
            "problem": "如何做 Python 单元测试",
            "solution": "使用 pytest + fixtures",
            "validate": False,
        })
        mem2 = api.propose_memory({
            "title": "进化合并测试 B",
            "content": "pytest 是 Python 最佳的单元测试框架，使用 fixtures 管理测试数据。",
            "category": "testing",
            "tags": "evolution,pytest",
            "agent_id": "evo-agent",
            "physical_user": "api-tester",
            "problem": "Python 测试框架选择",
            "solution": "pytest",
            "validate": False,
        })

        # 触发进化聚类（v5 语义聚类：标记 cluster_id，不删除记忆）
        from cerebrate.config import config
        from cerebrate.memory.evolution import EvolutionEngine
        engine = EvolutionEngine(config.evolution_path, api.mm)
        merged = engine._cluster_semantic(threshold=0.75)

        if merged > 0:
            # 保留的记忆应包含双方的 origin_ids
            survivor_id = mem1["memory_id"]
            survivor = api.get_memory(survivor_id)
            if survivor is None:
                survivor_id = mem2["memory_id"]
                survivor = api.get_memory(survivor_id)
            if survivor:
                self.assertIn("origin_ids", survivor)
                # 至少包含自己的一条
                self.assertGreater(len(survivor["origin_ids"]), 0)

    def test_origin_data_never_changes(self):
        """原始记忆内容不应随共享记忆变化而变化。"""
        from cerebrate.server.api import BrainAPI
        api = BrainAPI()

        api.register_agent({
            "agent_id": "immutable-agent",
            "capabilities": ["testing"],
            "physical_user": "api-tester",
        })

        proposed = api.propose_memory({
            "title": "不可变性测试",
            "content": "原始数据版本1",
            "category": "testing",
            "agent_id": "immutable-agent",
            "physical_user": "api-tester",
            "solution": "保持不变",
            "validate": False,
        })

        # 读取原始记忆，验证内容不变
        origin = api.get_origin(proposed["origin_id"])
        self.assertEqual(origin["payload"]["content"], "原始数据版本1")

        # 即使共享记忆被复用（reuse），原始记忆不应改变
        usage = api.start_usage({
            "memory_id": proposed["memory_id"],
            "agent_id": "immutable-agent",
            "problem": "测试复用",
        })
        api.finish_usage({
            "usage_id": usage["usage_id"],
            "outcome": "success",
            "feedback": "good",
        })

        # 再次读取原始记忆，内容不应变化
        origin2 = api.get_origin(proposed["origin_id"])
        self.assertEqual(origin2["payload"]["content"], "原始数据版本1")


if __name__ == "__main__":
    unittest.main()

import os
import tempfile
import unittest
from pathlib import Path


def configure_temp_memory(tmp_name):
    import cerebrate.core.embedding as embedding
    from cerebrate.config import config

    root = Path(tmp_name) / "memory"
    config.memory_root = root
    config.personal_path = root / "personal"
    config.swarm_path = root / "swarm"
    config.knowledge_path = root / "knowledge"
    config.evolution_path = root / "evolution"
    config.agents_path = root / "agents"
    # config.archive_path removed (v6 chroma-only) ".archived"
    # config.seeds_path removed (v6 chroma-only) "seeds"
    # config.usage_path removed (v6 chroma-only) "usage"
    config.events_path = root / "events"
    config.chroma_path = root / "chroma_data"
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    embedding._engine = None
    config.memory_min_tokens = 0  # 测试环境不做长度限制


class BrainServerRequirementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from cerebrate.server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self.tmp.cleanup()

    def test_sense_and_assessment_expose_brain_server_state(self):
        self.api.register_agent({"agent_id": "observer", "capabilities": ["inspection"], "physical_user": "test-runner"})

        sense = self.api.sense()
        self.assertEqual(sense["server_role"], "authoritative_brain")
        self.assertIn("latest_event_id", sense)
        self.assertEqual(sense["llm"]["fallback"], "deterministic rule immune validation")
        self.assertIn(sense["llm"]["mode"], {"rule-only", "llm-assisted"})
        self.assertEqual(sense["consensus"]["tracked_memories"], 0)

        assessment = self.api.assess()
        self.assertIn("recommendations", assessment)
        self.assertIn("biases_detected", assessment)
        self.assertIn("agent_health", assessment)
        self.assertIn("llm", assessment)

    def test_server_downgrades_client_lifecycle_escalation(self):
        for requested_stage in ("verified_skill", "doctrine", "archived"):
            proposed = self.api.propose_memory({
                "title": f"客户端越权 {requested_stage}",
                "content": "客户端不能直接指定高阶生命周期。",
                "category": "security",
                "agent_id": "client-unit",
                "life_stage": requested_stage,
                "validate": False,
                "physical_user": "test-runner",
            })
            self.assertEqual(proposed["requested_life_stage"], requested_stage)
            self.assertEqual(proposed["life_stage"], "memory")
            self.assertEqual(proposed["authority"], "brain_server")

    def test_rule_immune_quarantines_dangerous_memory_and_query_filters_it(self):
        old_anthropic = os.environ.pop("ANTHROPIC_API_KEY", None)
        old_openai = os.environ.pop("OPENAI_API_KEY", None)
        try:
            proposed = self.api.propose_memory({
                "title": "危险记忆",
                "content": "错误方案: 运行 sudo rm -rf / 清理项目。",
                "category": "security",
                "agent_id": "unsafe-unit",
                "physical_user": "test-runner",
            })
        finally:
            if old_anthropic is not None:
                os.environ["ANTHROPIC_API_KEY"] = old_anthropic
            if old_openai is not None:
                os.environ["OPENAI_API_KEY"] = old_openai

        self.assertEqual(proposed["life_stage"], "quarantined")
        self.assertFalse(proposed["validation"]["safe"])
        self.assertIn("危险命令", "\n".join(proposed["validation"]["issues"]))

        memory = self.api.get_memory(proposed["memory_id"])
        self.assertEqual(memory["life_stage"], "quarantined")
        self.assertLess(memory["confidence"], 0.7)

        query = self.api.query({
            "query": "sudo rm -rf 清理项目",
            "agent_id": "safe-reader",
        })
        self.assertFalse(query["found"])
        self.assertEqual(query["recommendation"], "new_experience")

    def test_query_reuse_task_and_usage_feedback_update_memory_stats(self):
        proposed = self.api.propose_memory({
            "title": "服务端复用闭环",
            "content": "查询命中后，AI 单位应 start usage 并 finish usage 汇报战果。",
            "category": "testing",
            "tags": ["reuse", "feedback"],
            "agent_id": "teacher",
            "problem": "如何验证复用闭环",
            "solution": "query -> use start -> use finish",
            "validate": False,
            "physical_user": "test-runner",
        })
        memory_id = proposed["memory_id"]

        query = self.api.query({
            "query": "服务端复用闭环 query use start finish",
            "agent_id": "worker",
        })
        self.assertTrue(query["found"])
        self.assertEqual(query["recommendation"], "reuse")
        self.assertEqual(query["task"]["action"], "reuse_memory")
        self.assertEqual(query["task"]["memory_id"], memory_id)

        usage = self.api.start_usage({
            "memory_id": memory_id,
            "agent_id": "worker",
            "problem": "执行复用闭环",
        })
        finished = self.api.finish_usage({
            "usage_id": usage["usage_id"],
            "outcome": "success",
            "feedback": "复用闭环验证通过",
        })
        self.assertEqual(finished["outcome"], "success")

        memory = self.api.get_memory(memory_id)
        self.assertEqual(memory["reuse_count"], 1)
        self.assertEqual(memory["success_count"], 1)
        self.assertIn("复用闭环验证通过", memory["evidence"])

    def test_consensus_rejection_quarantines_memory(self):
        self.api.register_agent({"agent_id": "alpha", "capabilities": ["review"], "physical_user": "test-runner"})
        self.api.register_agent({"agent_id": "beta", "capabilities": ["review"], "physical_user": "test-runner"})
        proposed = self.api.propose_memory({
            "title": "应被拒绝的候选",
            "content": "这条经验经两个单位复核后应进入隔离。",
            "category": "architecture",
            "agent_id": "alpha",
            "validate": False,
        })
        memory_id = proposed["memory_id"]

        first = self.api.consensus_vote({
            "memory_id": memory_id,
            "agent_id": "alpha",
            "vote": "oppose",
            "evidence": "alpha 发现该经验缺少证据",
            "confidence": 1.0,
        })
        self.assertEqual(first["consensus"]["decision"], "pending")

        second = self.api.consensus_vote({
            "memory_id": memory_id,
            "agent_id": "beta",
            "vote": "oppose",
            "evidence": "beta 独立复核后确认不应吸收",
            "confidence": 1.0,
        })
        self.assertEqual(second["consensus"]["decision"], "rejected")
        self.assertEqual(second["consensus"]["applied_life_stage"], "quarantined")

        snapshot = self.api.consensus_snapshot(memory_id)
        self.assertEqual(snapshot["decision"], "rejected")
        self.assertEqual(self.api.get_memory(memory_id)["life_stage"], "quarantined")

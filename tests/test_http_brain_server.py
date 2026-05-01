import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "cerebrate.py"


def configure_temp_memory(tmp_name):
    from config import config
    import memory.embedding as embedding

    root = Path(tmp_name) / "memory"
    config.memory_root = root
    config.personal_path = root / "personal"
    config.swarm_path = root / "swarm"
    config.knowledge_path = root / "knowledge"
    config.evolution_path = root / "evolution"
    config.agents_path = root / "agents"
    config.archive_path = root / ".archived"
    config.seeds_path = root / "seeds"
    config.usage_path = root / "usage"
    config.events_path = root / "events"
    config.chroma_path = root / "chroma_data"
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    embedding._engine = None


class BrainAPITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        configure_temp_memory(self.tmp.name)
        from server.api import BrainAPI
        self.api = BrainAPI()

    def tearDown(self):
        self.tmp.cleanup()

    def test_brain_api_records_events_and_feedback(self):
        self.api.register_agent({"agent_id": "api-unit", "capabilities": ["testing"]})
        proposed = self.api.propose_memory({
            "title": "API 脑虫测试记忆",
            "content": "BrainAPI 代表服务端权威入口。",
            "category": "testing",
            "agent_id": "api-unit",
            "solution": "服务端追加事件并写入记忆",
        })
        memory_id = proposed["memory_id"]
        query = self.api.query({"query": "BrainAPI 服务端 权威入口", "agent_id": "api-unit"})
        self.assertTrue(query["found"])
        usage = self.api.start_usage({
            "memory_id": memory_id,
            "agent_id": "api-unit",
            "problem": "验证 BrainAPI 闭环",
        })
        finished = self.api.finish_usage({
            "usage_id": usage["usage_id"],
            "outcome": "success",
            "feedback": "闭环有效",
        })
        self.assertEqual(finished["outcome"], "success")
        event_types = {event["event_type"] for event in self.api.events.read_after(0)}
        self.assertIn("memory.proposed", event_types)
        self.assertIn("usage.finished", event_types)

    def test_consensus_vote_is_event_not_direct_doctrine_mutation(self):
        self.api.register_agent({"agent_id": "api-unit", "capabilities": ["testing"]})
        proposed = self.api.propose_memory({
            "title": "共识候选",
            "content": "投票只是事件，不直接晋升规则。",
            "category": "architecture",
            "agent_id": "api-unit",
            "validate": False,
        })
        vote = self.api.consensus_vote({
            "memory_id": proposed["memory_id"],
            "agent_id": "api-unit",
            "vote": "support",
            "evidence": "测试证据足够长",
        })
        self.assertEqual(vote["event_type"], "consensus.vote")
        self.assertEqual(vote["consensus"]["decision"], "pending")
        self.assertEqual(self.api.doctrines()["count"], 0)
        self.assertEqual(self.api.get_memory(proposed["memory_id"])["life_stage"], "memory")

    def test_consensus_quorum_promotes_to_verified_skill_not_doctrine(self):
        self.api.register_agent({"agent_id": "alpha", "capabilities": ["review"]})
        self.api.register_agent({"agent_id": "beta", "capabilities": ["review"]})
        proposed = self.api.propose_memory({
            "title": "可共识技能",
            "content": "两个独立单位支持后，服务端可晋升为 verified_skill。",
            "category": "architecture",
            "agent_id": "alpha",
            "validate": False,
        })
        memory_id = proposed["memory_id"]

        first = self.api.consensus_vote({
            "memory_id": memory_id,
            "agent_id": "alpha",
            "vote": "support",
            "evidence": "alpha 复核通过并提供证据",
            "confidence": 1.0,
        })
        self.assertEqual(first["consensus"]["decision"], "pending")

        second = self.api.consensus_vote({
            "memory_id": memory_id,
            "agent_id": "beta",
            "vote": "support",
            "evidence": "beta 独立复核通过并提供证据",
            "confidence": 1.0,
        })
        self.assertEqual(second["consensus"]["decision"], "accepted")
        self.assertEqual(second["consensus"]["applied_life_stage"], "verified_skill")
        self.assertEqual(self.api.get_memory(memory_id)["life_stage"], "verified_skill")
        self.assertEqual(self.api.doctrines()["count"], 0)

    def test_llm_status_exposes_rule_only_fallback_without_key(self):
        from config import config
        old_provider = config.llm_provider
        old_anthropic = os.environ.pop("ANTHROPIC_API_KEY", None)
        old_openai = os.environ.pop("OPENAI_API_KEY", None)
        try:
            config.llm_provider = "anthropic"
            status = self.api.llm_status()
            self.assertEqual(status["mode"], "rule-only")
            self.assertFalse(status["api_key_present"])
            self.assertEqual(status["fallback"], "deterministic rule immune validation")
        finally:
            config.llm_provider = old_provider
            if old_anthropic is not None:
                os.environ["ANTHROPIC_API_KEY"] = old_anthropic
            if old_openai is not None:
                os.environ["OPENAI_API_KEY"] = old_openai

    def test_client_cannot_directly_create_doctrine(self):
        proposed = self.api.propose_memory({
            "title": "客户端伪造教条",
            "content": "客户端请求 doctrine 必须被服务端降级。",
            "category": "architecture",
            "agent_id": "api-unit",
            "life_stage": "doctrine",
        })
        self.assertEqual(proposed["requested_life_stage"], "doctrine")
        self.assertEqual(proposed["life_stage"], "memory")


class HttpBrainServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = os.environ.copy()
        self.env["CEREBRATE_MEMORY_ROOT"] = str(Path(self.tmp.name) / "memory")
        self.env["CEREBRATE_EMBEDDING_MODEL"] = "not-a-real-local-model"
        self.env["CEREBRATE_EMBEDDING_ALLOW_DOWNLOAD"] = "false"
        self.env["PYTHONPYCACHEPREFIX"] = str(Path(self.tmp.name) / "pycache")
        self.proc = subprocess.Popen(
            [
                sys.executable,
                str(CLI),
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--quiet",
            ],
            cwd=str(ROOT),
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        first_line = self.proc.stdout.readline()
        payload = json.loads(first_line)
        if payload.get("status") == "error" and payload.get("error", {}).get("details", {}).get("exception") == "PermissionError":
            self.proc.terminate()
            self.proc.wait(timeout=5)
            self.proc.stdout.close()
            self.proc.stderr.close()
            self.tmp.cleanup()
            raise unittest.SkipTest("socket bind is not permitted in this sandbox")
        self.base_url = payload["data"]["base_url"]

    def tearDown(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        if self.proc.stdout:
            self.proc.stdout.close()
        if self.proc.stderr:
            self.proc.stderr.close()
        self.tmp.cleanup()

    def get(self, path, params=None):
        query = f"?{urlencode(params)}" if params else ""
        with urlopen(f"{self.base_url}{path}{query}", timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))

    def post(self, path, payload):
        request = Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))

    def assert_v5_ok(self, payload):
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["meta"]["protocol"], "v5")
        self.assertIn("data", payload)

    def test_rest_endpoints_and_event_log(self):
        from client.http import BrainClient
        client_sense = BrainClient(self.base_url).get("/v1/sense")
        self.assert_v5_ok(client_sense)

        registered = self.post("/v1/agents/register", {
            "agent_id": "server-unit",
            "agent_type": "http",
            "capabilities": ["debugging"],
        })
        self.assert_v5_ok(registered)

        proposed = self.post("/v1/memories/propose", {
            "title": "HTTP 脑虫测试记忆",
            "content": "短请求提交事实，事件日志保存连续性，SSE 只负责广播。",
            "category": "testing",
            "tags": ["http", "brain"],
            "agent_id": "server-unit",
            "solution": "REST + event log + SSE",
            "life_stage": "memory",
        })
        self.assert_v5_ok(proposed)
        memory_id = proposed["data"]["memory_id"]

        fetched = self.get(f"/v1/memories/{memory_id}")
        self.assert_v5_ok(fetched)
        self.assertEqual(fetched["data"]["memory_id"], memory_id)

        queried = self.post("/v1/query", {
            "query": "HTTP 脑虫 事件日志 SSE",
            "agent_id": "server-unit",
        })
        self.assert_v5_ok(queried)
        self.assertTrue(queried["data"]["found"])

        started = self.post("/v1/usages/start", {
            "memory_id": memory_id,
            "agent_id": "server-unit",
            "problem": "验证 HTTP 复用闭环",
        })
        self.assert_v5_ok(started)
        usage_id = started["data"]["usage_id"]

        finished = self.post("/v1/usages/finish", {
            "usage_id": usage_id,
            "outcome": "success",
            "feedback": "HTTP 闭环有效",
        })
        self.assert_v5_ok(finished)

        vote = self.post("/v1/consensus/vote", {
            "memory_id": memory_id,
            "agent_id": "server-unit",
            "vote": "support",
            "evidence": "端到端测试支持",
        })
        self.assert_v5_ok(vote)

        consensus = self.get(f"/v1/consensus/{memory_id}")
        self.assert_v5_ok(consensus)
        self.assertEqual(consensus["data"]["memory_id"], memory_id)

        llm_status = self.get("/v1/llm/status")
        self.assert_v5_ok(llm_status)
        self.assertIn(llm_status["data"]["mode"], {"rule-only", "llm-assisted"})

        assessment = self.get("/v1/brain/assess")
        self.assert_v5_ok(assessment)
        self.assertIn("biases_detected", assessment["data"])

        events = self.get("/v1/events", {"cursor": 0, "limit": 20})
        self.assert_v5_ok(events)
        event_types = {event["event_type"] for event in events["data"]["events"]}
        self.assertIn("memory.proposed", event_types)
        self.assertIn("consensus.vote", event_types)

    def test_sse_once_stream_is_resumable(self):
        self.post("/v1/agents/register", {"agent_id": "sse-unit"})
        time.sleep(0.1)
        with urlopen(f"{self.base_url}/v1/events/stream?cursor=0&once=true&limit=5", timeout=10) as response:
            body = response.read().decode("utf-8")
        self.assertIn("event: agent.registered", body)
        self.assertIn("data:", body)

    def test_cli_is_http_client_not_local_authority(self):
        proc = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "register",
                "--url",
                self.base_url,
                "--id",
                "cli-unit",
            ],
            cwd=str(ROOT),
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        payload = json.loads(proc.stdout)
        self.assert_v5_ok(payload)

        proc = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "propose",
                "--url",
                self.base_url,
                "--title",
                "CLI 客户端候选",
                "--content",
                "CLI 只是 HTTP 客户端，服务端才写入权威记忆。",
                "--category",
                "testing",
                "--agent",
                "cli-unit",
            ],
            cwd=str(ROOT),
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        payload = json.loads(proc.stdout)
        self.assert_v5_ok(payload)
        self.assertEqual(payload["data"]["authority"], "brain_server")
        memory_id = payload["data"]["memory_id"]

        proc = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "llm",
                "status",
                "--url",
                self.base_url,
            ],
            cwd=str(ROOT),
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        payload = json.loads(proc.stdout)
        self.assert_v5_ok(payload)
        self.assertIn(payload["data"]["mode"], {"rule-only", "llm-assisted"})

        proc = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "brain",
                "assess",
                "--url",
                self.base_url,
            ],
            cwd=str(ROOT),
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        payload = json.loads(proc.stdout)
        self.assert_v5_ok(payload)

        proc = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "consensus",
                "--url",
                self.base_url,
                "--memory-id",
                memory_id,
            ],
            cwd=str(ROOT),
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        payload = json.loads(proc.stdout)
        self.assert_v5_ok(payload)
        self.assertEqual(payload["data"]["memory_id"], memory_id)


if __name__ == "__main__":
    unittest.main()

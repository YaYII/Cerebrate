"""MCP Streamable HTTP 传输层测试（/v1/mcp）。

覆盖:
  - initialize / ping / tools/list 标准方法
  - tools/call 读工具（sense）匿名可用
  - tools/call 写工具（propose）匿名 403；user token 200（validate=False）
  - 自助注册/登录工具（auth_register / auth_login）匿名可用
  - 管理工具（auth_rebind / batch_process）匿名/user 403；master 200
  - notifications/* 通知 → HTTP 202
  - 未知方法 → JSON-RPC -32601
  - GET /v1/mcp → 405
  - 批量数组请求
"""
import base64
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

MASTER = "test-mcp-master-token"


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
    config.auth_path = root / "auth"
    config.chroma_path = root / "chroma_data"
    config.docstore_path = root / "docstore"
    config.embedding_model = "not-a-real-local-model"
    config.embedding_allow_download = False
    config.memory_min_tokens = 0
    config.server_token = MASTER
    embedding._engine = None


def _current_code(secret):
    from cerebrate.server.auth import _hotp
    counter = int(time.time()) // 30
    return _hotp(base64.b32decode(secret.upper()), counter)


class McpHttpTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        configure_temp_env(cls.tmp.name)
        from cerebrate.server.http import create_server
        cls.server = create_server("127.0.0.1", 0, quiet=True)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(
            target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.6)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        from cerebrate.config import config
        config.server_token = ""
        cls.tmp.cleanup()

    def _mcp(self, message, token=None, method="POST",
             accept="application/json"):
        """发送一条 JSON-RPC 消息到 /v1/mcp，返回 (status, parsed)。"""
        data = json.dumps(message).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": accept,
        }
        if token:
            headers["Authorization"] = "Bearer " + token
        req = Request(f"http://127.0.0.1:{self.port}/v1/mcp",
                      data=data, headers=headers, method=method)
        try:
            with urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                if not raw:
                    return resp.status, None
                try:
                    return resp.status, json.loads(raw)
                except json.JSONDecodeError:
                    return resp.status, raw
        except HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                return e.code, json.loads(raw)
            except json.JSONDecodeError:
                return e.code, raw

    def _register_login(self, username):
        """走 REST 注册+登录，返回 user token（测试用户身份）。"""
        def req(method, path, body):
            data = json.dumps(body).encode()
            r = Request(f"http://127.0.0.1:{self.port}{path}",
                        data=data, method=method,
                        headers={"Content-Type": "application/json"})
            with urlopen(r, timeout=15) as resp:
                return json.loads(resp.read().decode())
        r = req("POST", "/v1/auth/register", {"username": username})
        secret = r["data"]["secret"]
        r = req("POST", "/v1/auth/login",
                {"username": username, "code": _current_code(secret)})
        return r["data"]["token"]

    # ── 标准 MCP 方法 ──────────────────────────────────────

    def test_initialize(self):
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26",
                       "capabilities": {}, "clientInfo": {"name": "t"}},
        })
        self.assertEqual(status, 200)
        self.assertEqual(r["jsonrpc"], "2.0")
        self.assertEqual(r["id"], 1)
        self.assertIn("protocolVersion", r["result"])
        self.assertEqual(r["result"]["serverInfo"]["name"],
                         "cerebrate-mcp")

    def test_ping(self):
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 2, "method": "ping",
        })
        self.assertEqual(status, 200)
        self.assertEqual(r["result"], {})

    def test_tools_list(self):
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 3, "method": "tools/list",
        })
        self.assertEqual(status, 200)
        tools = r["result"]["tools"]
        names = {t["name"] for t in tools}
        self.assertIn("cerebrate_sense", names)
        self.assertIn("cerebrate_propose", names)
        self.assertIn("cerebrate_auth_login", names)
        self.assertGreaterEqual(len(tools), 26)

    # ── 读工具：匿名可用 ───────────────────────────────────

    def test_sense_anonymous(self):
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "cerebrate_sense", "arguments": {}},
        })
        self.assertEqual(status, 200)
        self.assertEqual(r["result"]["isError"], False)
        self.assertIn("total_memories", r["result"]["content"][0]["text"])

    # ── 写工具：匿名 403，登录 200 ─────────────────────────

    def test_propose_anonymous_forbidden(self):
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {"name": "cerebrate_propose", "arguments": {
                "title": "匿名写", "content": "匿名不应能写记忆",
                "category": "testing", "tags": "t",
                "validate": False,
            }},
        })
        self.assertEqual(status, 200)
        self.assertEqual(r["result"]["isError"], True)
        self.assertIn("403", r["result"]["content"][0]["text"])

    def test_propose_login_ok(self):
        tok = self._register_login("mcp-writer")
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 6, "method": "tools/call",
            "params": {"name": "cerebrate_propose", "arguments": {
                "title": "MCP登录写测试", "content": "登录用户通过MCP写记忆",
                "category": "testing", "tags": "mcp",
                "validate": False,
            }},
        }, token=tok)
        self.assertEqual(status, 200)
        self.assertEqual(r["result"]["isError"], False)
        self.assertIn("memory_id", r["result"]["content"][0]["text"])

    # ── 自助注册/登录 ──────────────────────────────────────

    def test_auth_register_anonymous_ok(self):
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "cerebrate_auth_register",
                       "arguments": {"username": "mcp-reg"}},
        })
        self.assertEqual(status, 200)
        self.assertEqual(r["result"]["isError"], False)
        text = r["result"]["content"][0]["text"]
        self.assertIn("secret", text)
        self.assertIn("bind_token", text)

    def test_auth_login_anonymous_ok(self):
        # 先 REST 注册，再 MCP 匿名登录（无 token 场景）
        def req(method, path, body):
            data = json.dumps(body).encode()
            r = Request(f"http://127.0.0.1:{self.port}{path}",
                        data=data, method=method,
                        headers={"Content-Type": "application/json"})
            with urlopen(r, timeout=15) as resp:
                return json.loads(resp.read().decode())
        r = req("POST", "/v1/auth/register", {"username": "mcp-login"})
        secret = r["data"]["secret"]
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 8, "method": "tools/call",
            "params": {"name": "cerebrate_auth_login",
                       "arguments": {"username": "mcp-login",
                                     "code": _current_code(secret)}},
        })
        self.assertEqual(status, 200)
        self.assertEqual(r["result"]["isError"], False)
        text = r["result"]["content"][0]["text"]
        self.assertIn("token", text)
        self.assertIn("hint", text)

    # ── 管理工具：匿名/user 403，master 200 ────────────────

    def test_admin_tool_forbidden_anonymous(self):
        for name, args in [
                ("cerebrate_auth_rebind", {"username": "x"}),
                ("cerebrate_batch_process", {"limit": 1}),
        ]:
            status, r = self._mcp({
                "jsonrpc": "2.0", "id": 9, "method": "tools/call",
                "params": {"name": name, "arguments": args},
            })
            self.assertEqual(status, 200)
            self.assertEqual(r["result"]["isError"], True)
            self.assertIn("403", r["result"]["content"][0]["text"],
                          f"{name} 匿名应 403")

    def test_admin_tool_forbidden_user(self):
        tok = self._register_login("mcp-admin-guard")
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 10, "method": "tools/call",
            "params": {"name": "cerebrate_auth_rebind",
                       "arguments": {"username": "x"}},
        }, token=tok)
        self.assertEqual(status, 200)
        self.assertEqual(r["result"]["isError"], True)
        self.assertIn("403", r["result"]["content"][0]["text"])

    def test_admin_tool_master_ok(self):
        # 先注册用户（unittest 按方法名字母序执行，不能依赖其他测试）
        def req(method, path, body):
            data = json.dumps(body).encode()
            r = Request(f"http://127.0.0.1:{self.port}{path}",
                        data=data, method=method,
                        headers={"Content-Type": "application/json"})
            with urlopen(r, timeout=15) as resp:
                return json.loads(resp.read().decode())
        req("POST", "/v1/auth/register", {"username": "mcp-reg-master"})
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 11, "method": "tools/call",
            "params": {"name": "cerebrate_auth_rebind",
                       "arguments": {"username": "mcp-reg-master"}},
        }, token=MASTER)
        self.assertEqual(status, 200)
        self.assertEqual(r["result"]["isError"], False)
        self.assertIn("bind_token", r["result"]["content"][0]["text"])

    # ── 协议细节 ───────────────────────────────────────────

    def test_notification_202(self):
        status, body = self._mcp({
            "jsonrpc": "2.0", "method": "notifications/initialized",
        })
        self.assertEqual(status, 202)
        self.assertIsNone(body)

    def test_unknown_method_error(self):
        status, r = self._mcp({
            "jsonrpc": "2.0", "id": 12, "method": "bogus/method",
        })
        self.assertEqual(status, 200)
        self.assertEqual(r["error"]["code"], -32601)

    def test_get_method_not_allowed(self):
        status, _ = self._mcp({}, method="GET")
        self.assertEqual(status, 405)

    def test_batch_request(self):
        batch = [
            {"jsonrpc": "2.0", "id": 13, "method": "ping"},
            {"jsonrpc": "2.0", "id": 14, "method": "ping"},
        ]
        status, r = self._mcp(batch)
        self.assertEqual(status, 200)
        self.assertIsInstance(r, list)
        self.assertEqual(len(r), 2)
        self.assertEqual({item["id"] for item in r}, {13, 14})

    def test_parse_error(self):
        data = b"{not json"
        req = Request(f"http://127.0.0.1:{self.port}/v1/mcp",
                      data=data, method="POST",
                      headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=15) as resp:
                raw = resp.read().decode()
        except HTTPError as e:
            raw = e.read().decode()
        r = json.loads(raw)
        self.assertEqual(r["error"]["code"], -32700)


if __name__ == "__main__":
    unittest.main()

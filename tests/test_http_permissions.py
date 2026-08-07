"""HTTP 层权限测试 — 管理员角色隔离（管理端点 user token → 403）。

覆盖:
  - 无 token → 401
  - user token 读端点 200；管理端点（auth/users / soul/set / distill /
    evolve / answer / logs）403
  - user token 写记忆（propose）200（写权限保留）
  - master token 管理端点 200
  - project/profile save/attach 需 admin；read 允许
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

MASTER = "test-master-token"


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


class HttpPermissionTests(unittest.TestCase):
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

    def _req(self, method, path, body=None, token=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data, headers=headers, method=method)
        try:
            with urlopen(req, timeout=15) as resp:
                return resp.status, json.loads(resp.read().decode())
        except HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode())
            except Exception:
                return e.code, {}

    def _register_login(self, username):
        status, r = self._req(
            "POST", "/v1/auth/register", {"username": username})
        self.assertEqual(status, 200)
        secret = r["data"]["secret"]
        status, r = self._req(
            "POST", "/v1/auth/login",
            {"username": username, "code": _current_code(secret)})
        self.assertEqual(status, 200)
        return r["data"]["token"]

    def test_no_token_401(self):
        status, _ = self._req("GET", "/v1/sense")
        self.assertEqual(status, 401)

    def test_user_token_read_200(self):
        tok = self._register_login("reader")
        status, r = self._req("GET", "/v1/sense", token=tok)
        self.assertEqual(status, 200)
        self.assertEqual(r["status"], "ok")

    def test_user_token_admin_endpoints_403(self):
        tok = self._register_login("admin-guard")
        for method, path, body in [
                ("GET", "/v1/auth/users", None),
                ("POST", "/v1/soul/set", {"content": "x"}),
                ("POST", "/v1/distill", {"topic": "x"}),
                ("POST", "/v1/evolve", {}),
                ("POST", "/v1/answer", {"query": "x"}),
                ("GET", "/v1/logs", None),
                ("POST", "/v1/origins/cleanup", {"days": 365}),
                ("POST", "/v1/fulltext/rebuild", None),
                ("POST", "/v1/memories/dedup-check", {}),
        ]:
            status, _ = self._req(method, path, body, token=tok)
            self.assertEqual(status, 403, f"{method} {path} 应为 403")

    def test_user_token_write_memory_ok(self):
        tok = self._register_login("writer")
        status, r = self._req(
            "POST", "/v1/memories/propose", {
                "title": "权限写测试", "content": "普通用户写记忆权限应保留。",
                "category": "testing", "tags": "perm",
                "agent_id": "writer", "validate": False,
            }, token=tok)
        self.assertEqual(status, 200)
        self.assertEqual(r["status"], "ok")
        self.assertTrue(r["data"]["memory_id"])

    def test_master_token_admin_ok(self):
        status, r = self._req("GET", "/v1/auth/users", token=MASTER)
        self.assertEqual(status, 200)
        self.assertEqual(r["status"], "ok")
        status, r = self._req(
            "POST", "/v1/soul/set", {"content": "权限测试灵魂"},
            token=MASTER)
        self.assertEqual(status, 200)
        self.assertEqual(r["status"], "ok")

    def test_rebind_admin_only(self):
        # 管理员：为已注册用户重新生成绑定链接
        self._register_login("rebind-user")
        status, r = self._req(
            "POST", "/v1/auth/rebind", {"username": "rebind-user"},
            token=MASTER)
        self.assertEqual(status, 200)
        self.assertTrue(r["data"]["bind_token"])
        # 普通用户：403
        tok = self._register_login("rebind-guard")
        status, _ = self._req(
            "POST", "/v1/auth/rebind", {"username": "rebind-user"},
            token=tok)
        self.assertEqual(status, 403)
        # 未注册用户：400
        status, _ = self._req(
            "POST", "/v1/auth/rebind", {"username": "nobody"},
            token=MASTER)
        self.assertEqual(status, 400)

    def test_profile_save_requires_admin_but_read_allowed(self):
        tok = self._register_login("profile-user")
        # save（覆盖画像）需 admin
        status, _ = self._req(
            "POST", "/v1/project/profile",
            {"project": "perm", "action": "save", "profile": {}},
            token=tok)
        self.assertEqual(status, 403)
        # attach（挂载记忆）需 admin
        status, _ = self._req(
            "POST", "/v1/project/profile",
            {"project": "perm", "action": "attach",
             "node_path": "a/b", "memory_id": "x"},
            token=tok)
        self.assertEqual(status, 403)
        # read（读画像）允许（非 403；无画像时返回空或错误均不算权限拒绝）
        status, _ = self._req(
            "POST", "/v1/project/profile",
            {"project": "perm", "action": "read", "level": "summary"},
            token=tok)
        self.assertNotEqual(status, 403)


if __name__ == "__main__":
    unittest.main()

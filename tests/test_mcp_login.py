"""MCP 客户端登录流程测试（认证阶段3）。

覆盖:
  - 本地 token 持久化（写/读/清）
  - 生效 token 优先级：环境变量 > 本地文件
  - login CLI：正确 TOTP → 保存 token；失败 → 提示
  - logout / status CLI
  - _request 401 响应附带登录提示
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cerebrate.mcp as mcp


class TokenPersistenceTests(unittest.TestCase):
    """本地 token 文件读写与优先级。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token_file = Path(self.tmp.name) / "token"

    def tearDown(self):
        self.tmp.cleanup()

    def test_save_and_read(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file):
            mcp._save_token("tok-123", "alice")
            info = mcp._read_token_file()
            self.assertEqual(info["token"], "tok-123")
            self.assertEqual(info["user_id"], "alice")
            # 权限：仅本用户可读
            mode = self.token_file.stat().st_mode & 0o777
            self.assertLessEqual(mode, 0o600)

    def test_clear(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file):
            mcp._save_token("tok-123", "alice")
            mcp._clear_token()
            self.assertFalse(self.token_file.exists())
            self.assertEqual(mcp._read_token_file(), {})

    def test_effective_token_env_priority(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file):
            mcp._save_token("file-token", "alice")
            with mock.patch.dict(
                    os.environ,
                    {"CEREBRATE_SERVER_TOKEN": "env-token"}):
                self.assertEqual(mcp._load_effective_token(), "env-token")

    def test_effective_token_fallback_file(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file):
            mcp._save_token("file-token", "alice")
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CEREBRATE_SERVER_TOKEN", None)
                self.assertEqual(mcp._load_effective_token(), "file-token")

    def test_effective_token_empty(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file):
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CEREBRATE_SERVER_TOKEN", None)
                self.assertEqual(mcp._load_effective_token(), "")


class EnvFileConfigTests(unittest.TestCase):
    """本地配置 env 文件（install-mcp.sh 生成）读取。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_env_file_parsing(self):
        env_path = Path(self.tmp.name) / "cerebrate.env"
        env_path.write_text(
            "# 注释行\n"
            "CEREBRATE_SERVER_URL=\"https://x.example.com/cerebrate\"\n"
            "CEREBRATE_SERVER_TOKEN='envfile-tok'\n\n",
            encoding="utf-8")
        with mock.patch.object(mcp, "_MCP_ENV_FILE", str(env_path)):
            d = mcp._load_env_file()
        self.assertEqual(d["CEREBRATE_SERVER_URL"],
                         "https://x.example.com/cerebrate")
        self.assertEqual(d["CEREBRATE_SERVER_TOKEN"], "envfile-tok")

    def test_env_file_missing_returns_empty(self):
        with mock.patch.object(
                mcp, "_MCP_ENV_FILE", "/nonexistent/cerebrate.env"):
            self.assertEqual(mcp._load_env_file(), {})

    def test_effective_token_env_file_fallback(self):
        with mock.patch.object(
                mcp, "_ENV_FILE",
                {"CEREBRATE_SERVER_TOKEN": "envfile-tok"}), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CEREBRATE_SERVER_TOKEN", None)
            self.assertEqual(mcp._load_effective_token(), "envfile-tok")

    def test_effective_token_env_overrides_env_file(self):
        with mock.patch.object(
                mcp, "_ENV_FILE",
                {"CEREBRATE_SERVER_TOKEN": "envfile-tok"}), \
                mock.patch.dict(
                    os.environ,
                    {"CEREBRATE_SERVER_TOKEN": "env-tok"}):
            self.assertEqual(mcp._load_effective_token(), "env-tok")


class CliLoginTests(unittest.TestCase):
    """login/logout/status CLI 行为。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token_file = Path(self.tmp.name) / "token"

    def tearDown(self):
        self.tmp.cleanup()

    def test_login_success_saves_token(self):
        ok = {"status": "ok",
              "data": {"token": "new-token", "user_id": "alice"}}
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.object(mcp, "_request", return_value=ok):
            args = mock.Mock(username="alice", code="123456")
            self.assertEqual(mcp._cli_login(args), 0)
            self.assertEqual(mcp._read_token_file()["token"], "new-token")

    def test_login_failure_returns_error(self):
        fail = {"status": "error",
                "error": {"code": 400, "message": "TOTP 验证失败"}}
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.object(mcp, "_request", return_value=fail):
            args = mock.Mock(username="alice", code="000000")
            self.assertEqual(mcp._cli_login(args), 1)
            self.assertEqual(mcp._read_token_file(), {})

    def test_logout(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file):
            mcp._save_token("tok", "alice")
            self.assertEqual(mcp._cli_logout(mock.Mock()), 0)
            self.assertEqual(mcp._read_token_file(), {})

    def test_status_reports_login(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file):
            mcp._save_token("tok", "alice")
            # 不应抛异常，输出包含用户名
            with mock.patch("sys.stdout") as out:
                self.assertEqual(mcp._cli_status(mock.Mock()), 0)
            out.write.assert_called()

    def test_status_reports_env_file_source(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(
                    mcp, "_ENV_FILE",
                    {"CEREBRATE_SERVER_TOKEN": "envfile-tok"}), \
                mock.patch.object(
                    mcp, "_MCP_ENV_FILE", "/x/cerebrate.env"), \
                mock.patch("sys.stdout") as out:
            os.environ.pop("CEREBRATE_SERVER_TOKEN", None)
            mcp._cli_status(mock.Mock())
        # 输出应包含 env 文件来源说明
        texts = "".join(str(c) for c in out.write.call_args_list)
        self.assertIn("本地配置", texts)


class RequestAuthHintTests(unittest.TestCase):
    """_request 对 401 响应附加登录提示。"""

    def test_401_adds_login_hint(self):
        envelope = json.dumps({
            "status": "error",
            "error": {"code": 401, "message": "unauthorized", "details": {}},
        }).encode("utf-8")

        class FakeResp:
            def read(self):
                return envelope

            def close(self):
                return None

        err = __import__("urllib.error", fromlist=["HTTPError"]).HTTPError(
            url="http://x/v1/sense", code=401, msg="unauthorized",
            hdrs={}, fp=FakeResp())
        with mock.patch.object(
                mcp.urllib.request, "urlopen", side_effect=err):
            result = mcp._request("GET", "/v1/sense")
        self.assertEqual(result["status"], "error")
        self.assertIn("hint", result["error"])
        self.assertIn("login", result["error"]["hint"])


if __name__ == "__main__":
    unittest.main()

"""MCP 认证引导工具测试（AI 引导用户注册/登录流程，2026-08-06）。

覆盖:
  - cerebrate_auth_status：token 来源判定（env/file/none）+ 网络校验
  - cerebrate_auth_register：返回 otpauth_uri 与扫码提示
  - cerebrate_auth_login：成功保存 token / 失败不保存
  - cerebrate_auth_logout：清除本地 token
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cerebrate.mcp as mcp


class AuthStatusToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token_file = Path(self.tmp.name) / "token"

    def tearDown(self):
        self.tmp.cleanup()

    def test_status_none(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CEREBRATE_SERVER_TOKEN", None)
            r = mcp._handle_call("cerebrate_auth_status", {})
        self.assertEqual(r["status"], "ok")
        self.assertFalse(r["data"]["has_token"])
        self.assertEqual(r["data"]["source"], "none")

    def test_status_env_source(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.dict(
                    os.environ,
                    {"CEREBRATE_SERVER_TOKEN": "env-token"}):
            r = mcp._handle_call("cerebrate_auth_status", {})
        self.assertEqual(r["data"]["source"], "env")
        self.assertTrue(r["data"]["has_token"])

    def test_status_file_source(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CEREBRATE_SERVER_TOKEN", None)
            mcp._save_token("file-token", "alice")
            r = mcp._handle_call("cerebrate_auth_status", {})
        self.assertEqual(r["data"]["source"], "file")
        self.assertEqual(r["data"]["user_id"], "alice")

    def test_status_verify(self):
        ok = {"status": "ok", "data": {"user_id": "alice", "role": "user"}}
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(mcp, "_request", return_value=ok):
            os.environ.pop("CEREBRATE_SERVER_TOKEN", None)
            mcp._save_token("file-token", "alice")
            r = mcp._handle_call("cerebrate_auth_status", {"verify": True})
        self.assertEqual(r["data"]["verified_user"], "alice")


class AuthRegisterToolTests(unittest.TestCase):
    def test_register_returns_uri_and_hint(self):
        ok = {"status": "ok", "data": {
            "registered": True, "username": "bob",
            "otpauth_uri": "otpauth://totp/Cerebrate:bob?secret=XXXX",
            "secret": "XXXX"}}
        with mock.patch.object(mcp, "_request", return_value=ok):
            r = mcp._handle_call("cerebrate_auth_register",
                                 {"username": "bob"})
        self.assertEqual(r["status"], "ok")
        self.assertIn("otpauth_uri", r["data"])
        self.assertIn("hint", r["data"])
        self.assertIn("扫码", r["data"]["hint"])

    def test_register_failure_passthrough(self):
        fail = {"status": "error",
                "error": {"code": 400,
                          "message": "用户名须为 3-32 位小写字母/数字/下划线/连字符"}}
        with mock.patch.object(mcp, "_request", return_value=fail):
            r = mcp._handle_call("cerebrate_auth_register",
                                 {"username": "X"})
        self.assertEqual(r["status"], "error")


class AuthLoginToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token_file = Path(self.tmp.name) / "token"

    def tearDown(self):
        self.tmp.cleanup()

    def test_login_success_saves_token(self):
        ok = {"status": "ok", "data": {
            "token": "new-token", "user_id": "bob",
            "message": "登录成功"}}
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.object(mcp, "_request", return_value=ok):
            r = mcp._handle_call("cerebrate_auth_login",
                                 {"username": "bob", "code": "123456"})
            self.assertEqual(r["data"]["token_saved"], True)
            self.assertEqual(mcp._read_token_file()["token"], "new-token")

    def test_login_failure_does_not_save(self):
        fail = {"status": "error",
                "error": {"code": 400, "message": "TOTP 验证失败"}}
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file), \
                mock.patch.object(mcp, "_request", return_value=fail):
            r = mcp._handle_call("cerebrate_auth_login",
                                 {"username": "bob", "code": "000000"})
        self.assertEqual(r["status"], "error")
        self.assertEqual(mcp._read_token_file(), {})

    def test_logout_clears_token(self):
        with mock.patch.object(mcp, "_TOKEN_FILE", self.token_file):
            mcp._save_token("tok", "bob")
            r = mcp._handle_call("cerebrate_auth_logout", {})
        self.assertEqual(r["status"], "ok")
        self.assertEqual(mcp._read_token_file(), {})


if __name__ == "__main__":
    unittest.main()

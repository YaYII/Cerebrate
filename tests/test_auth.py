"""用户认证测试 — TOTP 注册/登录/user token。

覆盖:
  - TOTP 算法：RFC 6238 标准向量 + 当前码验证
  - 注册：返回 otpauth_uri + secret；重复注册提示已存在
  - 登录：正确 TOTP → token；错误码拒绝；未注册拒绝
  - 幂等：同用户重复登录复用同一 token
  - token resolve：有效 token → user_id；无效 → None
"""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cerebrate.server.auth import (
    UserAuth, _hotp, generate_secret, totp_uri, verify_totp,
)


# RFC 6238 附录 B 标准向量（SHA1 / 8 位，我们用 6 位需按格式取）
class TotpAlgorithmTests(unittest.TestCase):
    def test_generate_secret_is_base32(self):
        s = generate_secret()
        self.assertEqual(len(s), 32)  # 20 字节 → 32 字符 Base32
        self.assertTrue(all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" for c in s))

    def test_hotp_rfc_vector(self):
        """RFC 6238 SHA1 标准向量（6 位）。"""
        import base64, struct
        secret = base64.b32decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
        # RFC 6238: counter=0 → 755224; counter=1 → 287082; counter=2 → 359152
        self.assertEqual(_hotp(secret, 0), "755224")
        self.assertEqual(_hotp(secret, 1), "287082")
        self.assertEqual(_hotp(secret, 2), "359152")

    def test_verify_totp_current_code(self):
        secret = generate_secret()
        counter = int(time.time()) // 30
        import base64
        cur = _hotp(base64.b32decode(secret.upper()), counter)
        self.assertTrue(verify_totp(secret, cur))
        self.assertFalse(verify_totp(secret, "000000"))
        self.assertFalse(verify_totp(secret, "abc123"))

    def test_totp_uri_ascii_issuer(self):
        uri = totp_uri("张三", "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        self.assertTrue(uri.startswith("otpauth://totp/"))
        self.assertIn("issuer=Cerebrate", uri)
        self.assertIn("secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", uri)


class UserAuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.auth = UserAuth(Path(self.tmp.name) / "auth")

    def tearDown(self):
        self.tmp.cleanup()

    def _current_code(self, secret):
        import base64
        counter = int(time.time()) // 30
        return _hotp(base64.b32decode(secret.upper()), counter)

    def test_register_returns_uri(self):
        r = self.auth.register("alice")
        self.assertTrue(r["registered"])
        self.assertIn("otpauth://", r["otpauth_uri"])
        self.assertTrue(r["secret"])
        # 重复注册
        r2 = self.auth.register("alice")
        self.assertFalse(r2["registered"])

    def test_register_username_format_validation(self):
        """用户名须 3-32 位小写字母/数字/_-，防滥用抢占。"""
        for bad in ("", "ab", "Bad Name", "中文名", "a" * 33,
                    "has space", "UPPER"):
            with self.assertRaises(ValueError):
                self.auth.register(bad)
        # 合法：小写字母/数字/下划线/连字符，3-32 位
        r = self.auth.register("zhang-san_02")
        self.assertTrue(r["registered"])
        r2 = self.auth.register("a1-2_3")
        self.assertTrue(r2["registered"])

    def test_login_success_and_token_reuse(self):
        reg = self.auth.register("alice")
        code = self._current_code(reg["secret"])
        r = self.auth.login("alice", code)
        self.assertTrue(r["token"])
        self.assertEqual(r["user_id"], "alice")
        # 重复登录 → 复用同一 token（幂等）
        code2 = self._current_code(reg["secret"])
        r2 = self.auth.login("alice", code2)
        self.assertEqual(r2["token"], r["token"])

    def test_login_wrong_code_rejected(self):
        self.auth.register("bob")
        with self.assertRaises(ValueError):
            self.auth.login("bob", "123456")

    def test_login_unregistered_rejected(self):
        with self.assertRaises(ValueError):
            self.auth.login("nobody", "123456")

    def test_resolve_token(self):
        reg = self.auth.register("carol")
        login = self.auth.login("carol", self._current_code(reg["secret"]))
        self.assertEqual(self.auth.resolve(login["token"]), "carol")
        self.assertIsNone(self.auth.resolve("invalid-token"))
        self.assertIsNone(self.auth.resolve(""))

    def test_bind_session_lifecycle(self):
        """绑定页会话：生成 → 消费有效 → 无效/过期失效。"""
        self.auth.register("bob")
        token = self.auth.create_bind_session("bob")
        s = self.auth.consume_bind_session(token)
        self.assertIsNotNone(s)
        self.assertEqual(s["username"], "bob")
        self.assertIn("otpauth://", s["otpauth_uri"])
        self.assertTrue(s["secret"])
        # 无效 token
        self.assertIsNone(self.auth.consume_bind_session("bad-token"))
        self.assertIsNone(self.auth.consume_bind_session(""))
        # 过期 token（ttl 负数 → 立即过期）
        expired = self.auth.create_bind_session("bob", ttl_seconds=-1)
        self.assertIsNone(self.auth.consume_bind_session(expired))

    def test_bind_session_unknown_user(self):
        with self.assertRaises(ValueError):
            self.auth.create_bind_session("nobody")

    def test_persistence(self):
        """注册/登录后重建实例，token 仍可解析（JSON 持久化）。"""
        reg = self.auth.register("dave")
        login = self.auth.login("dave", self._current_code(reg["secret"]))
        auth2 = UserAuth(Path(self.tmp.name) / "auth")
        self.assertEqual(auth2.resolve(login["token"]), "dave")


if __name__ == "__main__":
    unittest.main()

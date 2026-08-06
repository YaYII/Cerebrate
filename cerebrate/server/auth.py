"""脑虫用户认证 — TOTP（Authenticator）登录 + 长期 user token。

设计（用户确定）:
  - 不用设备绑定（换设备无法用），改用 Authenticator（TOTP）登录绑定"人"
  - 注册：生成 TOTP secret，用户加入 authenticator（otpauth URI）
  - 登录：用户名 + 当前 TOTP 6 位码 → 验证通过 → 下发永久 user token
  - token 是唯一凭证，用户自己保存；下次请求直接带 token（免重复登录）
  - 权限：读共享；写/改记忆需 token 确定身份（owner 校验）

实现：RFC 6238 TOTP（HMAC-SHA1 / 6 位 / 30s 步长 / ±1 窗口），仅标准库，零依赖。
"""

import base64
import hashlib
import hmac
import json
import logging
import secrets
import struct
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_TOTP_STEP = 30
_TOTP_DIGITS = 6


def generate_secret() -> str:
    """生成 TOTP 共享密钥（20 字节随机 → Base32）。"""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii")


def totp_uri(username: str, secret: str) -> str:
    """生成 otpauth URI（供 Authenticator 扫码/手动添加）。
    issuer 用纯 ASCII「Cerebrate」（参照 TOTP 兼容性经验：避免非 ASCII issuer）。"""
    import urllib.parse
    label = urllib.parse.quote(f"Cerebrate:{username}")
    return (f"otpauth://totp/{label}?secret={secret}"
            f"&issuer=Cerebrate&algorithm=SHA1&digits={_TOTP_DIGITS}&period={_TOTP_STEP}")


def _hotp(secret_bytes: bytes, counter: int) -> str:
    msg = struct.pack(">Q", counter)
    digest = hmac.new(secret_bytes, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) \
        % (10 ** _TOTP_DIGITS)
    return str(code).zfill(_TOTP_DIGITS)


def verify_totp(secret_b32: str, code: str, window: int = 1) -> bool:
    """验证 TOTP 码：当前 30s 窗口 ±window 步。"""
    code = (code or "").strip()
    if not code or not code.isdigit():
        return False
    try:
        secret = base64.b32decode(secret_b32.upper())
    except Exception:
        return False
    counter = int(time.time()) // _TOTP_STEP
    for i in range(-window, window + 1):
        if _hotp(secret, counter + i) == code:
            return True
    return False


class UserAuth:
    """用户注册/登录/token 管理（JSON 持久化，线程安全）。"""

    def __init__(self, path: Optional[Path] = None):
        self._path = Path(path) if path else None
        self._lock = threading.Lock()
        self._users: dict[str, dict] = {}
        self._tokens: dict[str, dict] = {}
        if self._path:
            self._load()

    def _users_path(self) -> Path:
        return self._path / "users.json"

    def _tokens_path(self) -> Path:
        return self._path / "tokens.json"

    def _load(self):
        try:
            if self._users_path().exists():
                self._users = json.loads(self._users_path().read_text(encoding="utf-8"))
            if self._tokens_path().exists():
                self._tokens = json.loads(self._tokens_path().read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("UserAuth 加载失败: %s", e)

    def _save(self):
        if not self._path:
            return
        try:
            self._path.mkdir(parents=True, exist_ok=True)
            self._users_path().write_text(
                json.dumps(self._users, ensure_ascii=False, indent=2),
                encoding="utf-8")
            self._tokens_path().write_text(
                json.dumps(self._tokens, ensure_ascii=False, indent=2),
                encoding="utf-8")
        except Exception as e:
            logger.warning("UserAuth 保存失败: %s", e)

    def register(self, username: str) -> dict:
        """注册用户：返回 otpauth URI + secret（secret 仅此一次展示）。"""
        username = (username or "").strip()
        if not username:
            raise ValueError("username is required")
        with self._lock:
            user = self._users.get(username)
            if user:
                return {
                    "registered": False,
                    "message": f"用户 {username} 已存在，直接用 Authenticator 登录",
                    "username": username,
                }
            secret = generate_secret()
            self._users[username] = {
                "secret": secret,
                "created": datetime.now(timezone.utc).isoformat(),
            }
            self._save()
        return {
            "registered": True,
            "username": username,
            "secret": secret,
            "otpauth_uri": totp_uri(username, secret),
            "message": "把 otpauth_uri 加入 Authenticator（扫码或手动），然后登录",
        }

    def login(self, username: str, code: str) -> dict:
        """登录：验证 TOTP → 下发/返回长期 user token。"""
        username = (username or "").strip()
        code = (code or "").strip()
        with self._lock:
            user = self._users.get(username)
            if not user:
                raise ValueError(f"用户 {username} 未注册，请先注册")
            secret = user.get("secret", "")
            if not verify_totp(secret, code):
                raise ValueError("TOTP 验证失败，请检查 Authenticator 中的 6 位码")
            for tok, info in self._tokens.items():
                if info.get("user_id") == username:
                    return {
                        "token": tok,
                        "user_id": username,
                        "message": "登录成功（复用已有 token）",
                    }
            token = uuid.uuid4().hex
            self._tokens[token] = {
                "user_id": username,
                "created": datetime.now(timezone.utc).isoformat(),
            }
            self._save()
        return {
            "token": token,
            "user_id": username,
            "message": "登录成功，请妥善保存 token（唯一凭证，长期有效）",
        }

    def resolve(self, token: str) -> Optional[str]:
        """token → user_id（鉴权用）；无效返回 None。"""
        if not token:
            return None
        with self._lock:
            info = self._tokens.get(token.strip())
            return info.get("user_id") if info else None

    def list_users(self) -> list[dict]:
        with self._lock:
            return [{"username": u, "created": d.get("created", "")}
                    for u, d in self._users.items()]

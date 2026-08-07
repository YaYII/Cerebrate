"""Protocol helpers for CLI and HTTP brain responses."""

from typing import Any


def ok(data: Any | None = None, protocol: str = "v5", **kwargs) -> dict:
    """构造成功响应：{"status": "ok", "data": ..., "meta": {"protocol": ...}}。."""
    payload = data if data is not None else kwargs
    return {"status": "ok", "data": payload, "meta": {"protocol": protocol}}


def err(message: str, code: int = 1, protocol: str = "v5",
        details: dict | None = None, **kwargs) -> dict:
    """构造失败响应：{"status": "error", "error": {"code", "message", "details"}, ...}。."""
    error = {"code": code, "message": message, "details": details or {}}
    if kwargs:
        error["details"].update(kwargs)
    return {"status": "error", "error": error, "meta": {"protocol": protocol}}

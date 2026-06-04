"""Protocol helpers for CLI and HTTP brain responses."""

from typing import Any, Optional


def ok(data: Optional[Any] = None, protocol: str = "v5", **kwargs) -> dict:
    payload = data if data is not None else kwargs
    return {"status": "ok", "data": payload, "meta": {"protocol": protocol}}


def err(message: str, code: int = 1, protocol: str = "v5",
        details: Optional[dict] = None, **kwargs) -> dict:
    error = {"code": code, "message": message, "details": details or {}}
    if kwargs:
        error["details"].update(kwargs)
    return {"status": "error", "error": error, "meta": {"protocol": protocol}}

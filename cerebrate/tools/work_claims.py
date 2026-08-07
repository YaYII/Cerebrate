"""
多人协作感知：工作声明（谁在哪个项目/分支处理哪个功能）+ 冲突检测。.

背景（用户认知）:
  - 多人对同一功能处理 → 脑虫应知晓并告知，利于解决代码冲突
  - 同一项目不同分支 → 分支隔离 + 分支差异告知
  - 代码分析在本地（MCP 层），服务端只做 API 中枢（画像/记忆/协作感知）

存储: {memory_root}/work/{project_id}.json
"""

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from cerebrate.config import config

logger = logging.getLogger(__name__)


def _claims_path(project_id: str) -> Path:
    d = config.memory_root / "work"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{project_id}.json"


def _load(project_id: str) -> dict:
    p = _claims_path(project_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"claims": [], "updated_at": ""}


def _save(project_id: str, data: dict) -> None:
    data["updated_at"] = datetime.now(UTC).isoformat()
    p = _claims_path(project_id)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    tmp.replace(p)


def claim(project_id: str, agent_id: str, branch: str = "",
          module: str = "", intent: str = "",
          session_id: str = "") -> dict:
    """声明正在处理某功能。返回冲突检测结果（同模块已被他人声明）。."""
    if not project_id or not agent_id:
        raise ValueError("project_id and agent_id are required")
    data = _load(project_id)
    now = datetime.now(UTC).isoformat()
    # 冲突检测：同模块其他 active claim（排除自己）
    conflicts = []
    for c in data.get("claims", []):
        if c.get("status") != "active":
            continue
        if c.get("agent_id") == agent_id:
            continue
        if module and c.get("module") == module:
            conflicts.append({
                "agent_id": c["agent_id"], "branch": c.get("branch", ""),
                "module": c.get("module", ""), "intent": c.get("intent", ""),
                "claimed_at": c.get("claimed_at", ""),
            })
    # 更新/新增声明（同 agent+module 幂等）
    found = False
    for c in data.get("claims", []):
        if (c.get("agent_id") == agent_id and c.get("module") == module
                and c.get("branch") == branch):
            c.update({"intent": intent, "session_id": session_id,
                      "claimed_at": now, "status": "active"})
            found = True
            break
    if not found:
        data.setdefault("claims", []).append({
            "agent_id": agent_id, "branch": branch, "module": module,
            "intent": intent, "session_id": session_id,
            "claimed_at": now, "status": "active",
        })
    # 超时清理：超过 24h 的 active 自动视为 released（防止僵尸声明）
    for c in data.get("claims", []):
        if c.get("status") == "active" and c.get("claimed_at"):
            try:
                t = datetime.fromisoformat(c["claimed_at"])
                if (datetime.now(UTC) - t).total_seconds() > 86400:
                    c["status"] = "released"
                    c["released_reason"] = "auto-expired"
            except Exception:
                pass
    _save(project_id, data)
    return {
        "ok": True,
        "project_id": project_id,
        "agent_id": agent_id,
        "branch": branch,
        "module": module,
        "claimed_at": now,
        "conflict": len(conflicts) > 0,
        "conflicts": conflicts,
    }


def release(project_id: str, agent_id: str, module: str = "",
            claim_id: str = "") -> dict:
    """释放工作声明。."""
    data = _load(project_id)
    released = 0
    for c in data.get("claims", []):
        if c.get("status") != "active":
            continue
        if claim_id and c.get("claim_id") == claim_id:
            pass
        elif c.get("agent_id") == agent_id and (
                not module or c.get("module") == module):
            c["status"] = "released"
            c["released_at"] = datetime.now(UTC).isoformat()
            released += 1
    if released:
        _save(project_id, data)
    return {"ok": True, "project_id": project_id, "released": released}


def list_active(project_id: str) -> dict:
    """列出项目活跃工作声明（按分支/模块）。."""
    data = _load(project_id)
    claims = [c for c in data.get("claims", [])
              if c.get("status") == "active"]
    # 按分支分组
    by_branch: dict[str, list[dict]] = {}
    for c in claims:
        by_branch.setdefault(c.get("branch") or "default", []).append(c)
    return {
        "project_id": project_id,
        "active_count": len(claims),
        "by_branch": by_branch,
        "claims": claims,
    }

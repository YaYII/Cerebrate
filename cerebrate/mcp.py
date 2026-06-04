#!/usr/bin/env python3
"""
Cerebrate MCP Server v5 — 虫群记忆系统 MCP 服务

直接导入 BrainAPI 作为本地库调用，无需额外 HTTP 服务。
"""
from cerebrate.server.api import BrainAPI
import json
import sys
import os
import time

# 确保 cerebrate 包可导入（不受 CWD 影响）
_script_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.dirname(_script_dir)  # cerebrate/ 的父目录
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)
os.chdir(_project_root)


_api: BrainAPI | None = None


def _get_api() -> BrainAPI:
    global _api
    if _api is None:
        _api = BrainAPI()
    return _api

# ── 工具定义 ────────────────────────────────────────────────


TOOLS = [
    {
        "name": "cerebrate_sense",
        "description": "【会话开始必须调用】感知虫群脑状态，返回健康状态、记忆总数、代理数、warnings。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_help",
        "description": "获取 Cerebrate v5 API 发现文档，含所有可用命令、参数、返回格式。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_doctrines",
        "description": "读取权威教条（doctrine 生命阶段的记忆）。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_assess",
        "description": "脑虫元认知评估，返回偏见检测、类别健康度、代理贡献和改进建议。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_query",
        "description": "【遇到技术问题必须调用】搜索虫群记忆。返回 task 字段含 instructions 和 next_commands。\n决策矩阵:\n  recommendation=reuse (score>0.5) → 按 task.instructions 直接复用\n  recommendation=verify (score>0.2) → 参考后独立验证\n  recommendation=new_experience → 从零解决",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "问题描述"},
                "user": {"type": "string", "description": "用户ID", "default": "yangying"},
                "agent_id": {"type": "string", "description": "代理标识", "default": "codex"},
                "project_id": {"type": "string", "description": "项目ID（可选）", "default": ""}
            },
            "required": ["query"]
        }
    },
    {
        "name": "cerebrate_propose",
        "description": "【解决问题后调用】提交新记忆到虫群。替代 v3 的 share。\nlife_stage 说明:\n  memory: 直接存入虫群(默认)\n  nutrient: 存入营养池，需共识投票升级为 memory",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "记忆标题"},
                "content": {"type": "string", "description": "详细内容：场景、排查、根因、方案、验证、命令"},
                "category": {"type": "string", "enum": ["coding", "debugging", "architecture", "devops", "performance", "security", "testing", "config", "skill"]},
                "tags": {"type": "string", "description": "逗号分隔的标签"},
                "agent_id": {"type": "string", "description": "代理标识", "default": "codex"},
                "problem": {"type": "string", "description": "原始问题"},
                "solution": {"type": "string", "description": "一句话方案"},
                "life_stage": {"type": "string", "enum": ["memory", "nutrient"], "description": "记忆生命阶段", "default": "memory"},
                "confidence": {"type": "number", "description": "信心分数 0-1", "default": 1.0},
                "validate": {"type": "boolean", "description": "是否触发免疫验证", "default": True},
                "project_id": {"type": "string", "description": "项目ID（可选）", "default": ""}
            },
            "required": ["title", "content", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_propose_skill",
        "description": "【解决问题后调用】将可复用解决模式存为技能（category=skill, life_stage=memory）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "技能标题，格式：'技能: <名称>'"},
                "content": {"type": "string", "description": "场景、排查步骤、根因、方案、验证、命令"},
                "tags": {"type": "string", "description": "必须包含 skill_<领域>"},
                "agent_id": {"type": "string", "default": "codex"},
                "problem": {"type": "string", "description": "原始问题"},
                "solution": {"type": "string", "description": "方案"},
                "validate": {"type": "boolean", "default": True}
            },
            "required": ["title", "content", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_propose_lesson",
        "description": "【犯错并修正后调用】将错误教训存为记忆（category=skill, tags=skill_lesson）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "'教训: <问题>'"},
                "content": {"type": "string", "description": "错误现象、原因、正确做法"},
                "tags": {"type": "string", "description": "必须包含 skill_lesson"},
                "agent_id": {"type": "string", "default": "codex"},
                "problem": {"type": "string", "description": "触发错误的问题"},
                "solution": {"type": "string", "description": "正确做法"},
                "validate": {"type": "boolean", "default": True}
            },
            "required": ["title", "content", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_use_start",
        "description": "【复用记忆时调用】开始跟踪记忆复用（向虫群反馈哪些记忆被使用了）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "memory_id": {"type": "string", "description": "被复用的记忆ID"},
                "agent": {"type": "string", "default": "codex"},
                "problem": {"type": "string", "description": "解决的问题"},
                "project_id": {"type": "string", "default": ""}
            },
            "required": ["memory_id", "agent", "problem"]
        }
    },
    {
        "name": "cerebrate_use_finish",
        "description": "【复用完成时调用】完成记忆复用跟踪，报告结果。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "usage_id": {"type": "string", "description": "use_start 返回的 usage_id"},
                "outcome": {"type": "string", "enum": ["success", "partial", "failure"]},
                "feedback": {"type": "string", "description": "使用反馈", "default": ""}
            },
            "required": ["usage_id", "outcome"]
        }
    },
    {
        "name": "cerebrate_register",
        "description": "【首次使用前调用】注册当前 AI 代理到虫群系统。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "agent_id": {"type": "string", "default": "codex"},
                "agent_type": {"type": "string", "default": "mcp"},
                "capabilities": {"type": "string", "default": "code_generation,debugging,refactoring,testing"}
            }
        }
    },
    {
        "name": "cerebrate_vote",
        "description": "对虫群中的记忆进行共识投票。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "memory_id": {"type": "string", "description": "记忆ID"},
                "agent": {"type": "string", "default": "codex"},
                "vote": {"type": "string", "enum": ["support", "oppose", "abstain"]},
                "evidence": {"type": "string", "description": "投票理由", "default": ""},
                "confidence": {"type": "number", "default": 1.0}
            },
            "required": ["memory_id", "agent", "vote"]
        }
    },
    {
        "name": "cerebrate_evolve",
        "description": "【会话结束时调用】触发脑进化：去重、技能提取、衰减清理。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_stats",
        "description": "查看虫群系统统计信息：记忆数、代理数、共识状态等。",
        "inputSchema": {"type": "object", "properties": {}}
    }
]

# ── 工具调用实现 ────────────────────────────────────────────


def _handle_call(name: str, args: dict) -> dict:
    api = _get_api()
    try:
        if name == "cerebrate_sense":
            return {"status": "ok", "data": api.sense()}

        elif name == "cerebrate_help":
            return {"status": "ok", "data": api.help()}

        elif name == "cerebrate_doctrines":
            return {"status": "ok", "data": api.doctrines()}

        elif name == "cerebrate_assess":
            return {"status": "ok", "data": api.assess()}

        elif name == "cerebrate_query":
            result = api.query({
                "query": args["query"],
                "user": args.get("user", "yangying"),
                "agent_id": args.get("agent_id", "codex"),
                "project_id": args.get("project_id", "")
            })
            return {"status": "ok", "data": result}

        elif name == "cerebrate_propose":
            result = api.propose_memory({
                "title": args["title"],
                "content": args["content"],
                "category": args.get("category", "general"),
                "tags": args["tags"],
                "agent_id": args.get("agent_id", "codex"),
                "problem": args.get("problem", ""),
                "solution": args.get("solution", ""),
                "life_stage": args.get("life_stage", "memory"),
                "confidence": args.get("confidence", 1.0),
                "validate": args.get("validate", True),
                "project_id": args.get("project_id", "")
            })
            return {"status": "ok", "data": result}

        elif name == "cerebrate_propose_skill":
            result = api.propose_memory({
                "title": args["title"],
                "content": args["content"],
                "category": "skill",
                "tags": args["tags"],
                "agent_id": args.get("agent_id", "codex"),
                "problem": args.get("problem", ""),
                "solution": args.get("solution", ""),
                "life_stage": "memory",
                "confidence": 1.0,
                "validate": args.get("validate", True),
            })
            return {"status": "ok", "data": result}

        elif name == "cerebrate_propose_lesson":
            result = api.propose_memory({
                "title": args["title"],
                "content": args["content"],
                "category": "skill",
                "tags": f"skill_lesson,{args['tags']}",
                "agent_id": args.get("agent_id", "codex"),
                "problem": args.get("problem", ""),
                "solution": args.get("solution", ""),
                "life_stage": "memory",
                "confidence": 1.0,
                "validate": args.get("validate", True),
            })
            return {"status": "ok", "data": result}

        elif name == "cerebrate_use_start":
            result = api.start_usage({
                "memory_id": args["memory_id"],
                "agent": args["agent"],
                "problem": args["problem"],
                "project_id": args.get("project_id", "")
            })
            return {"status": "ok", "data": result}

        elif name == "cerebrate_use_finish":
            result = api.finish_usage({
                "usage_id": args["usage_id"],
                "outcome": args["outcome"],
                "feedback": args.get("feedback", "")
            })
            return {"status": "ok", "data": result}

        elif name == "cerebrate_register":
            result = api.register_agent({
                "agent_id": args.get("agent_id", "codex"),
                "agent_type": args.get("agent_type", "mcp"),
                "capabilities": args.get("capabilities", "code_generation,debugging,refactoring,testing").split(","),
            })
            return {"status": "ok", "data": result}

        elif name == "cerebrate_vote":
            result = api.consensus_vote({
                "memory_id": args["memory_id"],
                "agent": args["agent"],
                "vote": args["vote"],
                "evidence": args.get("evidence", ""),
                "confidence": args.get("confidence", 1.0),
            })
            return {"status": "ok", "data": result}

        elif name == "cerebrate_evolve":
            result = api.evolve()
            return {"status": "ok", "data": result}

        elif name == "cerebrate_stats":
            sense = api.sense()
            return {"status": "ok", "data": {
                "total_memories": sense.get("total_memories", 0),
                "total_agents": sense.get("total_agents", 0),
                "agent_ids": sense.get("agent_ids", []),
                "warnings": sense.get("warnings", []),
                "llm": sense.get("llm", {}),
                "consensus": sense.get("consensus", {}),
                "health": sense.get("health", "unknown"),
            }}

        else:
            return {"status": "error", "error": {"code": -1, "message": f"未知工具: {name}"}}

    except Exception as e:
        return {"status": "error", "error": {"code": 500, "message": str(e)}}


# ── MCP stdio 协议实现 ──────────────────────────────────────

def _send(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    _send({
        "jsonrpc": "2.0",
        "method": "server/info",
        "params": {
            "name": "cerebrate-mcp-v5",
            "version": "5.0.0",
            "capabilities": {"tools": {}}
        }
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = req.get("id")
        method = req.get("method", "")
        params = req.get("params", {})

        if method == "initialize":
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "0.1.0",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "cerebrate-mcp-v5", "version": "5.0.0"}
                }
            })
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})
            result = _handle_call(tool_name, tool_args)
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}]
                }
            })
        elif method == "notifications/initialized":
            pass
        else:
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -1, "message": f"未知方法: {method}"}
            })


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Cerebrate MCP Server v5 — 虫群记忆系统 MCP 服务

通过 HTTP 访问独立运行的脑虫 Brain Server（可在 Docker 容器中），
而非本地实例化 BrainAPI。连接地址与鉴权令牌通过环境变量配置：
  CEREBRATE_SERVER_URL   — 脑虫服务地址，默认 http://127.0.0.1:8765
  CEREBRATE_SERVER_TOKEN — Bearer 鉴权令牌，留空则不鉴权
"""
import sys
import os
import json
import urllib.request
import urllib.error


_SERVER_URL = os.environ.get("CEREBRATE_SERVER_URL", "") or "http://127.0.0.1:8765"
_SERVER_TOKEN = os.environ.get("CEREBRATE_SERVER_TOKEN", "")


def _request(method: str, path: str, body: dict = None) -> dict:
    """向脑虫 Brain Server 发起 HTTP 请求，返回 v5 协议 JSON 信封。"""
    full_url = _SERVER_URL.rstrip("/") + path
    data = None
    headers = {"Content-Type": "application/json"}
    if _SERVER_TOKEN:
        headers["Authorization"] = f"Bearer {_SERVER_TOKEN}"
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(full_url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8") if e.fp else "{}"
        try:
            return json.loads(err_body)
        except json.JSONDecodeError:
            return {"status": "error", "error": {"code": e.code, "message": err_body}}
    except urllib.error.URLError as e:
        return {"status": "error", "error": {"code": 503, "message": f"无法连接脑虫服务 {full_url}: {e.reason}"}}


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
    },
    {
        "name": "cerebrate_recall",
        "description": "【会话开始调用】读取个人偏好和上下文缓存。",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_remember",
        "description": "【学到偏好时调用】写入个人偏好: user/key/value。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "user": {"type": "string", "description": "用户ID", "default": "yangying"},
                "key": {"type": "string", "description": "偏好键名"},
                "value": {"type": "string", "description": "偏好值"}
            },
            "required": ["key", "value"]
        }
    },
    {
        "name": "cerebrate_batch_process",
        "description": "【会话结束时调用】批量处理 IPC 队列中的待办请求。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "最大处理数量", "default": 50}
            }
        }
    }
]

# ── 工具调用实现 ────────────────────────────────────────────


def _handle_call(name: str, args: dict) -> dict:
    try:
        if name == "cerebrate_sense":
            return _request("GET", "/v1/sense")

        elif name == "cerebrate_help":
            return _request("GET", "/v1/help")

        elif name == "cerebrate_doctrines":
            return _request("GET", "/v1/doctrines")

        elif name == "cerebrate_assess":
            return _request("GET", "/v1/brain/assess")

        elif name == "cerebrate_query":
            return _request("POST", "/v1/query", {
                "query": args["query"],
                "user": args.get("user", "yangying"),
                "agent_id": args.get("agent_id", "codex"),
                "project_id": args.get("project_id", "")
            })

        elif name == "cerebrate_propose":
            return _request("POST", "/v1/memories/propose", {
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

        elif name == "cerebrate_propose_skill":
            return _request("POST", "/v1/memories/propose", {
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

        elif name == "cerebrate_propose_lesson":
            return _request("POST", "/v1/memories/propose", {
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

        elif name == "cerebrate_use_start":
            return _request("POST", "/v1/usages/start", {
                "memory_id": args["memory_id"],
                "agent": args["agent"],
                "problem": args["problem"],
                "project_id": args.get("project_id", "")
            })

        elif name == "cerebrate_use_finish":
            return _request("POST", "/v1/usages/finish", {
                "usage_id": args["usage_id"],
                "outcome": args["outcome"],
                "feedback": args.get("feedback", "")
            })

        elif name == "cerebrate_register":
            return _request("POST", "/v1/agents/register", {
                "agent_id": args.get("agent_id", "codex"),
                "agent_type": args.get("agent_type", "mcp"),
                "capabilities": args.get("capabilities", "code_generation,debugging,refactoring,testing").split(","),
            })

        elif name == "cerebrate_vote":
            return _request("POST", "/v1/consensus/vote", {
                "memory_id": args["memory_id"],
                "agent": args["agent"],
                "vote": args["vote"],
                "evidence": args.get("evidence", ""),
                "confidence": args.get("confidence", 1.0),
            })

        elif name == "cerebrate_evolve":
            return _request("POST", "/v1/evolve", {})

        elif name == "cerebrate_stats":
            envelope = _request("GET", "/v1/sense")
            if envelope.get("status") != "ok":
                return envelope
            sense = envelope.get("data", {})
            return {"status": "ok", "data": {
                "total_memories": sense.get("total_memories", 0),
                "total_agents": sense.get("total_agents", 0),
                "agent_ids": sense.get("agent_ids", []),
                "warnings": sense.get("warnings", []),
                "llm": sense.get("llm", {}),
                "consensus": sense.get("consensus", {}),
                "health": sense.get("health", "unknown"),
            }}

        elif name == "cerebrate_recall":
            return _request("GET", "/v1/personal")

        elif name == "cerebrate_remember":
            return _request("POST", "/v1/personal", {
                "user": args.get("user", "yangying"),
                "key": args["key"],
                "value": args["value"]
            })

        elif name == "cerebrate_batch_process":
            return _request("POST", "/v1/batch/process", {
                "limit": args.get("limit", 50)
            })

        else:
            return {"status": "error", "error": {"code": -1, "message": f"未知工具: {name}"}}

    except KeyError as e:
        return {"status": "error", "error": {"code": 400, "message": f"缺少必填参数: {e}"}}
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
            client_version = params.get("protocolVersion", "2024-11-05")
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": client_version,
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

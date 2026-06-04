#!/usr/bin/env python3
"""
Cerebrate MCP Server — 虫群记忆系统 MCP 服务

Codex 通过 MCP 协议调用本服务，所有 Cerebrate 操作以工具函数形式暴露。
工具注册在函数列表中，不受对话长度影响，全程可用。
"""
import json
import subprocess
import sys
import os

CEREBRATE_DIR = os.path.dirname(os.path.abspath(__file__))
USER_ID = "yangying"

# ── Cerebrate CLI 调用封装 ──────────────────────────────────


def _run(args: list[str]) -> dict:
    """执行 cerebrate.py 命令，返回解析后的 JSON"""
    result = subprocess.run(
        ["python3", "cerebrate.py"] + args,
        cwd=CEREBRATE_DIR,
        capture_output=True, text=True, timeout=120
    )
    return json.loads(result.stdout)

# ── 工具定义 ────────────────────────────────────────────────


TOOLS = [
    {
        "name": "cerebrate_sense",
        "description": (
            "【会话开始必须调用】感知虫群系统健康状态，检查是否有 warnings。"
            "先调用此工具，如果有 warnings 需要向用户报告。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "human": {
                    "type": "boolean",
                    "description": "是否输出人类可读格式",
                    "default": False
                }
            }
        }
    },
    {
        "name": "cerebrate_recall",
        "description": (
            "【会话开始必须调用】回忆用户偏好、历史笔记和关键结论。"
            "调用后根据返回的 memories 调整交互风格、避免重复询问。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "user": {
                    "type": "string",
                    "description": "用户ID",
                    "default": USER_ID
                }
            }
        }
    },
    {
        "name": "cerebrate_query",
        "description": (
            "【遇到任何技术问题必须调用】检索虫群经验和技能。"
            "根据返回结果决策："
            "score>0.7且category=skill → 直接按技能执行；"
            "score>0.5 → 复用方案；"
            "score>0.2 → 参考后独立验证；"
            "found=false → 从零解决，解决后存为技能"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "问题描述，尽量详细"
                },
                "user": {
                    "type": "string",
                    "description": "用户ID",
                    "default": USER_ID
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "cerebrate_share_skill",
        "description": (
            "【解决问题后调用】将可复用的解决模式存为技能（category=skill）。"
            "下次遇到相同或类似问题时，cerebrate_query 会自动检索到本技能。"
            "只在确认该解决方案具有复用价值时调用。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "技能标题，格式：'技能: <名称>'"
                },
                "content": {
                    "type": "string",
                    "description": "详细内容，包含问题场景、排查步骤、根因、解决方案、验证方法、关键命令"
                },
                "tags": {
                    "type": "string",
                    "description": "逗号分隔的标签，必须包含 skill_<领域>"
                },
                "problem": {
                    "type": "string",
                    "description": "原始问题描述"
                },
                "solution": {
                    "type": "string",
                    "description": "一句话解决方案"
                },
                "force": {
                    "type": "boolean",
                    "description": "是否强制写入（跳过免疫验证）",
                    "default": False
                }
            },
            "required": ["title", "content", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_share_experience",
        "description": (
            "【解决问题后调用】分享一次性经验（非技能类），存入虫群供后续参考。"
            "适用于不适合提炼为技能的特定场景经验。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "经验标题"},
                "content": {"type": "string", "description": "详细经验内容"},
                "category": {
                    "type": "string",
                    "description": "分类",
                    "enum": ["coding", "debugging", "architecture", "devops",
                             "performance", "security", "testing", "config"]
                },
                "tags": {"type": "string", "description": "逗号分隔的标签"},
                "problem": {"type": "string", "description": "原始问题"},
                "solution": {"type": "string", "description": "解决方案"},
                "force": {"type": "boolean", "default": False}
            },
            "required": ["title", "content", "category", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_share_lesson",
        "description": (
            "【犯错并修正后调用】将错误教训存为技能（category=skill, tags包含skill_lesson）。"
            "让虫群记住这个错误，其他代理和后续会话可以避免重蹈覆辙。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "教训标题，格式：'教训: <问题>'"
                },
                "content": {
                    "type": "string",
                    "description": "详细内容：错误现象、错误原因、正确做法"
                },
                "tags": {
                    "type": "string",
                    "description": "必须包含 skill_lesson"
                },
                "problem": {"type": "string", "description": "触发错误的原始问题"},
                "solution": {"type": "string", "description": "正确的做法"},
                "force": {"type": "boolean", "default": False}
            },
            "required": ["title", "content", "tags", "problem", "solution"]
        }
    },
    {
        "name": "cerebrate_remember",
        "description": (
            "【学到用户偏好或关键结论时调用】记住用户的一句话偏好或结论。"
            "后续 cerebrate_recall 可以检索到。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "记忆键名，如 'pref_tone'、'note_数据库优化'"
                },
                "value": {
                    "type": "string",
                    "description": "记忆值，简短的一句话"
                },
                "user": {
                    "type": "string",
                    "description": "用户ID",
                    "default": USER_ID
                }
            },
            "required": ["key", "value"]
        }
    },
    {
        "name": "cerebrate_evolve",
        "description": (
            "【会话结束时调用】触发虫群进化：自动去重、技能提取、衰减清理。"
            "建议在调用 cerebrate_batch_process 后调用。"
        ),
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_batch_process",
        "description": (
            "【会话结束时调用】处理 IPC 队列中的待办请求。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "最大处理数量",
                    "default": 50
                }
            }
        }
    },
    {
        "name": "cerebrate_stats",
        "description": (
            "查看虫群系统统计信息：总记忆数、代理数、语义索引状态等。"
        ),
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "cerebrate_agent_register",
        "description": (
            "【首次使用前调用】将当前 AI 工具注册到虫群系统。"
            "注册后系统才能识别和管理当前代理。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "string",
                    "description": "代理标识符",
                    "default": "codex"
                },
                "capabilities": {
                    "type": "string",
                    "description": "能力列表，逗号分隔",
                    "default": "code_generation,debugging,refactoring,testing"
                }
            }
        }
    }
]

# ── 工具调用实现 ────────────────────────────────────────────


def _handle_call(name: str, args: dict) -> dict:
    """根据工具名称分发到对应的 Cerebrate 命令"""
    try:
        if name == "cerebrate_sense":
            cmd = ["sense"]
            if args.get("human"):
                cmd.append("--human")
            return _run(cmd)

        elif name == "cerebrate_recall":
            return _run(["recall", "--user", args.get("user", USER_ID)])

        elif name == "cerebrate_query":
            return _run([
                "query", args["query"],
                "--user", args.get("user", USER_ID)
            ])

        elif name == "cerebrate_share_skill":
            cmd = [
                "share",
                "--title", args["title"],
                "--content", args["content"],
                "--category", "skill",
                "--tags", args["tags"],
                "--agent", "codex",
                "--problem", args["problem"],
                "--solution", args["solution"],
                "--validate"
            ]
            if args.get("force"):
                cmd.append("--force")
            return _run(cmd)

        elif name == "cerebrate_share_experience":
            cmd = [
                "share",
                "--title", args["title"],
                "--content", args["content"],
                "--category", args["category"],
                "--tags", args["tags"],
                "--agent", "codex",
                "--problem", args["problem"],
                "--solution", args["solution"],
                "--validate"
            ]
            if args.get("force"):
                cmd.append("--force")
            return _run(cmd)

        elif name == "cerebrate_share_lesson":
            cmd = [
                "share",
                "--title", args["title"],
                "--content", args["content"],
                "--category", "skill",
                "--tags", f"skill_lesson,{args['tags']}",
                "--agent", "codex",
                "--problem", args["problem"],
                "--solution", args["solution"],
                "--validate"
            ]
            if args.get("force"):
                cmd.append("--force")
            return _run(cmd)

        elif name == "cerebrate_remember":
            return _run([
                "remember",
                "--user", args.get("user", USER_ID),
                "--key", args["key"],
                "--value", args["value"]
            ])

        elif name == "cerebrate_evolve":
            return _run(["evolve"])

        elif name == "cerebrate_batch_process":
            return _run(["batch", "process", "--limit", str(args.get("limit", 50))])

        elif name == "cerebrate_stats":
            return _run(["stats"])

        elif name == "cerebrate_agent_register":
            return _run([
                "agent", "register",
                "--id", args.get("agent_id", "codex"),
                "--type", "cli",
                "--capabilities", args.get("capabilities",
                                           "code_generation,debugging,refactoring,testing")
            ])

        else:
            return {"status": "error", "error": {"code": -1, "message": f"未知工具: {name}"}}

    except subprocess.TimeoutExpired:
        return {"status": "error", "error": {"code": -1, "message": "Cerebrate 命令执行超时"}}
    except json.JSONDecodeError as e:
        return {"status": "error", "error": {"code": -1, "message": f"Cerebrate 输出解析失败: {e}"}}
    except Exception as e:
        return {"status": "error", "error": {"code": -1, "message": str(e)}}


# ── MCP stdio 协议实现 ──────────────────────────────────────

def _send(msg: dict):
    """向 stdout 发送 JSON-RPC 消息（MCP 协议）"""
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    """MCP Server 主循环：通过 stdin 读取 JSON-RPC 请求"""
    # 发送 server 能力声明
    _send({
        "jsonrpc": "2.0",
        "method": "server/info",
        "params": {
            "name": "cerebrate-mcp",
            "version": "1.0.0",
            "capabilities": {
                "tools": {}
            }
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
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "cerebrate-mcp",
                        "version": "1.0.0"
                    }
                }
            })

        elif method == "tools/list":
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": TOOLS}
            })

        elif method == "tools/call":
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})
            result = _handle_call(tool_name, tool_args)
            # 将 Cerebrate 返回包装为 MCP content 格式
            content_text = json.dumps(result, ensure_ascii=False, indent=2)
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{
                        "type": "text",
                        "text": content_text
                    }]
                }
            })

        elif method == "notifications/initialized":
            # 忽略初始化完成通知
            pass

        else:
            _send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -1, "message": f"未知方法: {method}"}
            })


if __name__ == "__main__":
    main()

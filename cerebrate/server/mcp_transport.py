"""MCP Streamable HTTP 传输层 — 标准 MCP 端点（/v1/mcp）。

按 MCP 规范（2025-03-26 Streamable HTTP）实现：
  - POST /v1/mcp：JSON-RPC 消息（initialize / tools/list / tools/call）
  - GET /v1/mcp：405（不支持服务端主动 SSE，规范允许）
  - 无状态（不返回 Mcp-Session-Id，客户端无需会话管理）
  - 鉴权由 HTTP 层 Bearer token 完成（user/master token）

同事接入（零本地安装）：
  claude mcp add --transport http cerebrate https://<域名>/cerebrate/v1/mcp --header "Authorization: Bearer <token>"
"""

import json

from cerebrate.protocol import ok

MCP_PROTOCOL_VERSION = "2025-03-26"
SERVER_INFO = {"name": "cerebrate-mcp", "version": "5.1.1"}


# ── 工具定义（JSON Schema，与 mcp.py / mcp.js 一致）─────────
def _tools() -> list[dict]:
    return [
        {"name": "cerebrate_sense", "description": "【会话开始必须调用】感知虫群脑状态，返回健康状态、记忆总数、代理数、warnings。", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "cerebrate_help", "description": "获取 Cerebrate v5 API 发现文档。", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "cerebrate_doctrines", "description": "读取权威教条（doctrine 生命阶段的记忆）。", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "cerebrate_assess", "description": "脑虫元认知评估。", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "cerebrate_query", "description": "【决策查询】完整内容 + 推荐动作（reuse/verify/new_experience）。", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "user": {"type": "string", "default": "yangying"}, "agent_id": {"type": "string", "default": "codex"}, "project_id": {"type": "string", "default": ""}, "scope": {"type": "string", "enum": ["", "general", "project", "all"], "default": ""}}, "required": ["query"]}},
        {"name": "cerebrate_search", "description": "【遇到问题第一步调用】渐进式披露第1层：紧凑索引。mode: hybrid/fts/vector。", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "agent_id": {"type": "string", "default": "codex"}, "project_id": {"type": "string", "default": ""}, "scope": {"type": "string", "enum": ["", "general", "project", "all"], "default": ""}, "category": {"type": "string", "default": ""}, "mode": {"type": "string", "enum": ["hybrid", "fts", "vector"], "default": "hybrid"}, "limit": {"type": "number", "default": 20}}, "required": ["query"]}},
        {"name": "cerebrate_timeline", "description": "【前因后果】围绕 anchor 记忆的时序上下文。", "inputSchema": {"type": "object", "properties": {"anchor": {"type": "string", "default": ""}, "query": {"type": "string", "default": ""}, "project_id": {"type": "string", "default": ""}, "scope": {"type": "string", "enum": ["", "general", "project", "all"], "default": ""}, "depth_before": {"type": "number", "default": 3}, "depth_after": {"type": "number", "default": 3}}}},
        {"name": "cerebrate_detail", "description": "【按需取详情】按 ids 批量取完整详情。", "inputSchema": {"type": "object", "properties": {"ids": {"type": "array", "items": {"type": "string"}}}, "required": ["ids"]}},
        {"name": "cerebrate_propose", "description": "【解决问题后调用】提交新记忆到虫群。可选 skill_markdown 提交结构化技能（SKILL.md frontmatter+body，v5.6 借鉴腾讯）。", "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "content": {"type": "string"}, "category": {"type": "string", "enum": ["coding", "debugging", "architecture", "devops", "performance", "security", "testing", "config", "skill"]}, "tags": {"type": "string"}, "agent_id": {"type": "string", "default": "codex"}, "problem": {"type": "string", "default": ""}, "solution": {"type": "string", "default": ""}, "life_stage": {"type": "string", "enum": ["memory", "nutrient"], "default": "memory"}, "confidence": {"type": "number", "default": 1.0}, "validate": {"type": "boolean", "default": True}, "project_id": {"type": "string", "default": ""}, "scope": {"type": "string", "enum": ["", "general", "project"], "default": ""}, "supersedes": {"type": "string", "default": ""}, "observation_type": {"type": "string", "default": ""}, "facts": {"type": "string", "default": ""}, "concepts": {"type": "string", "default": ""}, "skill_markdown": {"type": "string", "default": ""}}, "required": ["title", "content", "tags", "problem", "solution"]}},
        {"name": "cerebrate_use_start", "description": "【复用记忆】开始跟踪记忆复用。", "inputSchema": {"type": "object", "properties": {"memory_id": {"type": "string"}, "agent": {"type": "string", "default": "codex"}, "problem": {"type": "string"}, "project_id": {"type": "string", "default": ""}}, "required": ["memory_id", "agent", "problem"]}},
        {"name": "cerebrate_use_finish", "description": "【复用完成】报告复用结果。", "inputSchema": {"type": "object", "properties": {"usage_id": {"type": "string"}, "outcome": {"type": "string", "enum": ["success", "partial", "failure"]}, "feedback": {"type": "string", "default": ""}}, "required": ["usage_id", "outcome"]}},
        {"name": "cerebrate_vote", "description": "对虫群记忆进行共识投票。", "inputSchema": {"type": "object", "properties": {"memory_id": {"type": "string"}, "agent": {"type": "string", "default": "codex"}, "vote": {"type": "string", "enum": ["support", "oppose", "abstain"]}, "evidence": {"type": "string", "default": ""}, "confidence": {"type": "number", "default": 1.0}}, "required": ["memory_id", "agent", "vote"]}},
        {"name": "cerebrate_stats", "description": "查看虫群系统统计信息。", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "cerebrate_recall", "description": "读取个人偏好。", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "cerebrate_remember", "description": "写入个人偏好。", "inputSchema": {"type": "object", "properties": {"user": {"type": "string", "default": "yangying"}, "key": {"type": "string"}, "value": {"type": "string"}}, "required": ["key", "value"]}},
        {"name": "cerebrate_knowledge_search", "description": "搜索权威知识库。", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "topic": {"type": "string", "default": ""}, "project_id": {"type": "string", "default": ""}, "scope": {"type": "string", "enum": ["", "general", "project", "all"], "default": ""}}, "required": ["query"]}},
        {"name": "cerebrate_project_context", "description": "【项目上下文】生成/读取浓缩上下文。", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "action": {"type": "string", "enum": ["build", "read", "list"], "default": "build"}, "limit": {"type": "integer", "default": 50}}, "required": ["project"]}},
        {"name": "cerebrate_project_profile", "description": "【业务画像】数据世界+流程世界。action: read/list/draft/save/attach。", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "action": {"type": "string", "enum": ["read", "list", "draft", "save", "attach"], "default": "read"}, "level": {"type": "string", "enum": ["summary", "graph", "detail"], "default": "detail"}, "llm_refine": {"type": "boolean", "default": False}, "profile": {"type": "object"}, "node_path": {"type": "string", "default": ""}, "memory_id": {"type": "string", "default": ""}}, "required": ["project"]}},
        {"name": "cerebrate_project_navigate", "description": "【画像导航】定位目标域/实体。", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "target": {"type": "string"}}, "required": ["project", "target"]}},
        {"name": "cerebrate_project_work", "description": "【多人协作】工作声明 claim/release/list。", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "action": {"type": "string", "enum": ["claim", "release", "list"], "default": "list"}, "branch": {"type": "string", "default": ""}, "module": {"type": "string", "default": ""}, "intent": {"type": "string", "default": ""}, "agent_id": {"type": "string", "default": ""}}, "required": ["project"]}},
        {"name": "cerebrate_entity_extract", "description": "【本地实体化衍生】本地抽取实体（HTTP 远程端点不保留本地实体数据，返回提示；请用本地 MCP）。", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "persist": {"type": "boolean", "default": True}, "top": {"type": "number", "default": 30}}, "required": ["text"]}},
        {"name": "cerebrate_auth_status", "description": "查看当前 token 身份（服务端认证结果）。", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "cerebrate_auth_register", "description": "注册新用户（自助：无需 token 即可调用；注册后需扫码绑定+登录获取 token）。", "inputSchema": {"type": "object", "properties": {"username": {"type": "string"}}, "required": ["username"]}},
        {"name": "cerebrate_auth_login", "description": "登录获取长期 token（自助：无需 token 即可调用；输入用户名 + Authenticator 当前 6 位码，返回 token 请自行记录保存，作为唯一凭证）。", "inputSchema": {"type": "object", "properties": {"username": {"type": "string"}, "code": {"type": "string"}}, "required": ["username", "code"]}},
        {"name": "cerebrate_auth_rebind", "description": "【管理员】为已注册用户重新生成绑定链接（master token）。", "inputSchema": {"type": "object", "properties": {"username": {"type": "string"}}, "required": ["username"]}},
        {"name": "cerebrate_knowledge_store", "description": "【管理员】存入知识库（master token）。", "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "content": {"type": "string"}, "topics": {"type": "string", "default": ""}, "project": {"type": "string", "default": ""}}, "required": ["title", "content"]}},
        {"name": "cerebrate_ingest", "description": "【管理员】文档吸入知识库（master token）。", "inputSchema": {"type": "object", "properties": {"dir": {"type": "string"}, "project": {"type": "string", "default": ""}, "dry_run": {"type": "boolean", "default": False}, "verbose": {"type": "boolean", "default": False}}, "required": ["dir"]}},
        {"name": "cerebrate_project_harvest", "description": "【管理员】本地代码分析推结构（master token）。", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "dir": {"type": "string"}, "exts": {"type": "array", "items": {"type": "string"}}}, "required": ["project"]}},
        {"name": "cerebrate_batch_process", "description": "【管理员】批量处理 IPC 队列（master token）。", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "default": 50}}}},
    ]


MCP_TOOLS = _tools()


# ── 工具权限 ─────────────────────────────────────────────
# 管理工具（与 REST _ADMIN_ENDPOINTS 对齐：仅 master token / 本地开发可用）
_ADMIN_ONLY_TOOLS = {
    "cerebrate_auth_rebind",
    "cerebrate_knowledge_store",
    "cerebrate_ingest",
    "cerebrate_project_harvest",
    "cerebrate_batch_process",
}

# 写工具（需登录：user token 或 master token；匿名拒绝，防污染/刷票）
_WRITE_TOOLS = {
    "cerebrate_propose",
    "cerebrate_remember",
    "cerebrate_vote",
    "cerebrate_use_start",
    "cerebrate_use_finish",
    "cerebrate_entity_extract",
}


def _auth_gate(current_user: str, is_admin: bool, name: str) -> dict | None:
    """按身份把关工具调用：返回错误 dict 表示拒绝，None 表示放行。"""
    if name in _ADMIN_ONLY_TOOLS and not is_admin:
        return {"status": "error", "error": {
            "code": 403,
            "message": f"{name} 需要管理员权限（master token）"}}
    if name in _WRITE_TOOLS and not current_user and not is_admin:
        return {"status": "error", "error": {
            "code": 403,
            "message": f"{name} 需要登录（请先 cerebrate_auth_register + "
                       f"cerebrate_auth_login 获取 token 并配置 Bearer 鉴权）"}}
    return None


def _rpc_error(code: int, message: str, req_id=None) -> dict:
    err = {"code": code, "message": message}
    if req_id is not None:
        return {"jsonrpc": "2.0", "id": req_id, "error": err}
    return {"jsonrpc": "2.0", "id": None, "error": err}


def _call_result(data: dict) -> dict:
    """MCP tools/call 结果（与 mcp.js 一致）。"""
    return {
        "content": [{"type": "text",
                     "text": json.dumps(data, ensure_ascii=False, indent=2)}],
        "isError": data.get("status") == "error",
    }


def handle_mcp_rpc(body: dict, api, current_user: str = "",
                   is_admin: bool = False) -> dict:
    """处理单个 JSON-RPC 消息，返回 MCP 响应（dict 或 None=通知不响应）。"""
    method = body.get("method", "")
    req_id = body.get("id")
    params = body.get("params", {}) or {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": params.get("protocolVersion")
                or MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None  # 通知无响应（HTTP 层返回 202）
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id,
                "result": {"tools": MCP_TOOLS}}
    if method == "tools/call":
        name = params.get("name", "")
        args = params.get("arguments", {}) or {}
        data = _invoke_tool(api, name, args, current_user, is_admin)
        # 统一信封：_invoke_tool 错误路径已返回 {status:error}；成功路径返回
        # API 裸 data（对齐 REST 层 ok() 信封，与 mcp.py 客户端行为一致）。
        if not (isinstance(data, dict)
                and data.get("status") in ("ok", "error")):
            data = {"status": "ok", "data": data}
        return {"jsonrpc": "2.0", "id": req_id,
                "result": _call_result(data)}
    return _rpc_error(-32601, f"未知方法: {method}", req_id)


def _invoke_tool(api, name: str, args: dict, current_user: str,
                 is_admin: bool) -> dict:
    """MCP 工具 → 服务端 API（参数转换与 mcp.py/mcp.js 对齐）。"""
    try:
        denied = _auth_gate(current_user, is_admin, name)
        if denied:
            return denied
        if name == "cerebrate_sense":
            return api.sense()
        if name == "cerebrate_help":
            return api.help()
        if name == "cerebrate_doctrines":
            return api.doctrines()
        if name == "cerebrate_assess":
            return api.assess()
        if name == "cerebrate_query":
            return api.query({
                "query": args["query"], "user": args.get("user", "yangying"),
                "agent_id": args.get("agent_id", "codex"),
                "project_id": args.get("project_id", ""),
                "scope": args.get("scope", ""), "detail": True,
            })
        if name == "cerebrate_search":
            return api.search({
                "query": args["query"], "agent_id": args.get("agent_id", "codex"),
                "project_id": args.get("project_id", ""), "scope": args.get("scope", ""),
                "category": args.get("category", ""), "mode": args.get("mode", "hybrid"),
                "limit": args.get("limit", 20),
            })
        if name == "cerebrate_timeline":
            return api.timeline({
                "anchor": args.get("anchor", ""), "query": args.get("query", ""),
                "project_id": args.get("project_id", ""), "scope": args.get("scope", ""),
                "depth_before": args.get("depth_before", 3),
                "depth_after": args.get("depth_after", 3),
            })
        if name == "cerebrate_detail":
            return api.memory_detail({"ids": args.get("ids", [])})
        if name == "cerebrate_propose":
            payload = dict(args)
            payload.setdefault("_current_user", current_user)
            return api.propose_memory(payload)
        if name == "cerebrate_use_start":
            return api.start_usage({
                "memory_id": args["memory_id"], "agent": args.get("agent", "codex"),
                "problem": args.get("problem", ""), "project_id": args.get("project_id", ""),
            })
        if name == "cerebrate_use_finish":
            return api.finish_usage({
                "usage_id": args["usage_id"], "outcome": args["outcome"],
                "feedback": args.get("feedback", ""),
            })
        if name == "cerebrate_vote":
            return api.consensus_vote({
                "memory_id": args["memory_id"], "agent": args.get("agent", "codex"),
                "vote": args["vote"], "evidence": args.get("evidence", ""),
                "confidence": args.get("confidence", 1.0),
            })
        if name == "cerebrate_stats":
            s = api.sense()
            if not isinstance(s, dict) or "total_memories" not in s:
                return s
            return {
                "total_memories": s.get("total_memories", 0),
                "total_agents": s.get("total_agents", 0),
                "agent_ids": s.get("agent_ids", []),
                "warnings": s.get("warnings", []),
                "llm": s.get("llm", {}), "consensus": s.get("consensus", {}),
                "health": s.get("health", "unknown"),
            }
        if name == "cerebrate_recall":
            return api.get_personal()
        if name == "cerebrate_remember":
            return api.set_personal({
                "user": args.get("user", "yangying"), "key": args["key"],
                "value": args["value"],
            })
        if name == "cerebrate_knowledge_search":
            return api.search_knowledge(
                args.get("query", ""), topic=args.get("topic", ""),
                project_id=args.get("project_id", ""), scope=args.get("scope", ""))
        if name == "cerebrate_project_context":
            return api.project_context({
                "project": args.get("project", ""), "action": args.get("action", "build"),
                "limit": args.get("limit", 50),
            })
        if name == "cerebrate_project_profile":
            return api.project_profile({
                "project": args.get("project", ""), "action": args.get("action", "read"),
                "level": args.get("level", "detail"), "llm_refine": args.get("llm_refine", False),
                "profile": args.get("profile"), "node_path": args.get("node_path", ""),
                "memory_id": args.get("memory_id", ""),
            })
        if name == "cerebrate_project_navigate":
            return api.project_navigate({
                "project": args.get("project", ""), "target": args.get("target", ""),
            })
        if name == "cerebrate_project_work":
            if args.get("action", "list") in ("claim", "release") \
                    and not current_user and not is_admin:
                return {"status": "error", "error": {
                    "code": 403,
                    "message": "cerebrate_project_work claim/release 需要登录"
                               "（匿名只允许 list）"}}
            return api.project_work({
                "project": args.get("project", ""), "action": args.get("action", "list"),
                "branch": args.get("branch", ""), "module": args.get("module", ""),
                "intent": args.get("intent", ""), "agent_id": args.get("agent_id", ""),
            })
        if name == "cerebrate_entity_extract":
            return {"status": "error", "error": {
                "code": 400,
                "message": "实体抽取是本地 MCP 能力（数据不离开本地）；HTTP 远程端点不保留实体数据，请用本地 MCP（npx/npm）接入",
            }}
        if name == "cerebrate_auth_status":
            if is_admin:
                role = "admin"
            elif current_user:
                role = "user"
            else:
                role = "anonymous"
            return {"status": "ok", "data": {
                "user_id": current_user, "role": role,
            }}
        if name == "cerebrate_auth_register":
            return api.register_user({"username": args.get("username", "")})
        if name == "cerebrate_auth_login":
            result = api.login_user({
                "username": args.get("username", ""),
                "code": args.get("code", ""),
            })
            if result.get("token"):
                result["hint"] = (
                    "登录成功。token 是唯一凭证，请自行记录保存（本地持久化）；"
                    "之后所有请求用 Authorization: Bearer <token> 即可，无需每次授权")
            return result
        if name == "cerebrate_auth_rebind":
            return api.rebind_user({"username": args.get("username", "")})
        if name == "cerebrate_knowledge_store":
            return api.store_knowledge({
                "title": args.get("title", ""), "content": args.get("content", ""),
                "topics": [t.strip() for t in
                           (args.get("topics", "") or "").split(",") if t.strip()],
                "source": "mcp-knowledge-store", "is_policy": False,
                "author": "mcp-client", "project_id": args.get("project", ""),
            })
        if name == "cerebrate_ingest":
            from cerebrate.tools.ingest import ingest_directory
            return ingest_directory(
                root=args.get("dir", ""), project_id=args.get("project", ""),
                dry_run=args.get("dry_run", False), verbose=args.get("verbose", False))
        if name == "cerebrate_project_harvest":
            return api.project_harvest({
                "project": args.get("project", ""), "dir": args.get("dir", ""),
                "exts": args.get("exts"),
            })
        if name == "cerebrate_batch_process":
            return api.batch_process({"limit": args.get("limit", 50)})
        return {"status": "error", "error": {
            "code": -1, "message": f"未知工具: {name}"}}
    except KeyError as e:
        return {"status": "error", "error": {
            "code": 400, "message": f"缺少必填参数: {e}"}}
    except Exception as e:
        return {"status": "error", "error": {
            "code": 500, "message": str(e)}}

"""HTTP transport for the authoritative Cerebrate Brain Server."""

import json
import signal
import threading
import time
import hmac
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

from cerebrate.config import config
from cerebrate.protocol import err, ok
from cerebrate.server.api import BrainAPI
from cerebrate.server.mcp_transport import (
    handle_mcp_rpc, _rpc_error,
)


# ── 管理端点（admin-only）──────────────────────────────
# 普通 user token 调用返回 403；master token（或本地开发无鉴权模式）放行。
# 新增管理/花钱/全局写端点时必须加入此集合，防止权限旁路。
_ADMIN_ENDPOINTS = {
    ("GET", "/v1/auth/users"),
    ("POST", "/v1/auth/rebind"),
    ("POST", "/v1/soul/set"),
    ("POST", "/v1/knowledge"),
    ("POST", "/v1/knowledge/distill"),
    ("POST", "/v1/distill"),
    ("POST", "/v1/fulltext/rebuild"),
    ("POST", "/v1/memories/dedup-check"),
    ("POST", "/v1/evolve"),
    ("POST", "/v1/answer"),
    ("POST", "/v1/code/sync"),
    ("POST", "/v1/harvest/push"),
    ("POST", "/v1/project/harvest"),
    ("POST", "/v1/project/branch-diff"),
    ("POST", "/v1/ingest"),
    ("POST", "/v1/batch/process"),
    ("POST", "/v1/origins/cleanup"),
}


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """限制并发处理线程数，防高并发线程爆炸（阶段 1 扩展）。

    用 ThreadPoolExecutor(max_workers) 提交请求处理：超出上限的请求进入
    有界队列排队（而非无限开线程），配合客户端超时保护服务稳定性。
    """

    daemon_threads = True

    def __init__(self, server_address, RequestHandlerClass,
                 max_workers: int = 64, bind_and_activate: bool = True):
        super().__init__(server_address, RequestHandlerClass,
                         bind_and_activate=bind_and_activate)
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="cerebrate-http")

    def process_request(self, request, client_address):
        self._executor.submit(self.process_request_thread,
                              request, client_address)

    def shutdown(self):
        self._executor.shutdown(wait=False, cancel_futures=True)
        super().shutdown()


class BrainRequestHandler(BaseHTTPRequestHandler):
    server_version = "CerebrateBrain/5"

    @property
    def api(self) -> BrainAPI:
        return self.server.api  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):
        if getattr(self.server, "quiet", False):  # type: ignore[attr-defined]
            return
        super().log_message(fmt, *args)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def _handle(self, method: str):
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            # 认证免认证：用户尚无 token 时自助注册/登录（注册生成 otpauth_uri，
            # 不产生可用 token，篡改仍受 owner 模型约束）
            if method == "POST" and path in ("/v1/auth/login",
                                             "/v1/auth/register"):
                data = self._dispatch(method, path, parse_qs(parsed.query))
                self._send_json(ok(data, protocol="v5"))
                return
            if method == "GET" and path == "/v1/auth/bind":
                # 绑定页免认证：用户扫码时尚未登录；URL 带短时效 bind_token
                token = parse_qs(parsed.query).get("token", [""])[0]
                html = self.api.auth_bind_page(token)
                self._send_raw(html, "text/html; charset=utf-8",
                               extra_headers={"Cache-Control": "no-store"})
                return
            if method == "GET" and path.startswith("/mcp/"):
                # MCP 客户端分发（同事下载，无需鉴权）：
                #   /mcp/mcp.js        Node 版 MCP server
                #   /mcp/install.sh    一键安装脚本
                #   /mcp/VERSION       版本信息
                self._serve_mcp_artifact(path)
                return
            if path == "/v1/mcp":
                # MCP Streamable HTTP 端点：自行解析身份，不强制 401
                # （允许匿名调用自助注册/登录工具；工具级权限由
                #  mcp_transport._auth_gate 把关：写工具需登录、管理工具仅 admin）。
                self._parse_mcp_auth()
                self._handle_mcp(method)
                return
            if not self._check_auth():
                self._send_json(err("unauthorized", code=401, protocol="v5"),
                                HTTPStatus.UNAUTHORIZED)
                return
            # 管理端点权限隔离：普通用户调用管理/花钱/全局写端点 → 403
            if self._endpoint_requires_admin(method, path) and not self._is_admin():
                self._send_json(err("admin required", code=403, protocol="v5"),
                                HTTPStatus.FORBIDDEN)
                return
            params = parse_qs(parsed.query)
            if path == "/v1/events/stream" and method == "GET":
                self._handle_sse(params)
                return
            data = self._dispatch(method, path, params)
            self._send_json(ok(data, protocol="v5"))
        except KeyError as e:
            self._send_json(err(str(e), code=404, protocol="v5"),
                            HTTPStatus.NOT_FOUND)
        except PermissionError as e:
            self._send_json(err(str(e), code=403, protocol="v5"),
                            HTTPStatus.FORBIDDEN)
        except ValueError as e:
            self._send_json(err(str(e), code=400, protocol="v5"),
                            HTTPStatus.BAD_REQUEST)
        except Exception as e:
            self._send_json(err(str(e), code=500, protocol="v5",
                                exception=e.__class__.__name__),
                            HTTPStatus.INTERNAL_SERVER_ERROR)

    def _parse_mcp_auth(self):
        """解析 MCP 请求身份（与 _check_auth 一致，但允许匿名继续）。

        - Bearer user token → current_user=uid, is_admin=False
        - Bearer master token → current_user="", is_admin=True
        - 无 token 且无 master（本地开发）→ current_user="", is_admin=True
        - 无 token / 无效 token（生产有 master）→ current_user="", is_admin=False（匿名）
        工具级权限由 mcp_transport._auth_gate 把关（写需登录、管理仅 admin）。
        """
        self.current_user = ""
        self.is_admin = False
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            master = config.server_token
            self.is_admin = not master
            return
        token = header[len("Bearer "):].strip()
        uid = self.api.auth.resolve(token)
        if uid:
            self.current_user = uid
            self.is_admin = False
            return
        master = config.server_token
        if master and hmac.compare_digest(token, master):
            self.is_admin = True
            return
        # 无效 token → 匿名（不强制 401，工具层按需拒绝）
        self.is_admin = False

    def _handle_mcp(self, method: str):
        """处理 MCP Streamable HTTP 端点（POST /v1/mcp）。

        规范（2025-03-26）：
          - POST：JSON-RPC 消息（支持单对象与批量数组）
          - GET：405（服务端不实现主动 SSE，规范允许）
          - 纯通知（无 id / 无响应）→ 202 Accepted
          - 鉴权由调用方 _check_auth() 完成（Bearer token → current_user）
        """
        if method != "POST":
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED,
                            "MCP endpoint requires POST")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            if not raw.strip():
                body = []
            else:
                body = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            self._send_mcp_json(_rpc_error(-32700,
                                           "Parse error: invalid JSON", None))
            return

        messages = body if isinstance(body, list) else [body]
        responses = []
        for msg in messages:
            if not isinstance(msg, dict):
                responses.append(_rpc_error(-32600, "Invalid Request", None))
                continue
            resp = handle_mcp_rpc(
                msg, self.api,
                getattr(self, "current_user", ""),
                getattr(self, "is_admin", False))
            if resp is not None:
                responses.append(resp)

        if not responses:
            # 纯通知（notifications/*）→ 202 Accepted，无响应体
            self.send_response(HTTPStatus.ACCEPTED)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        payload = responses[0] if not isinstance(body, list) else responses
        accept = self.headers.get("Accept", "")
        if "text/event-stream" in accept and "application/json" not in accept:
            # 客户端只接受 SSE：以 SSE 帧包装 JSON（简单流式，兼容规范）
            frame = (f"data: {json.dumps(payload, ensure_ascii=False)}\n\n")
            self._send_raw(frame, "text/event-stream; charset=utf-8")
            return
        self._send_mcp_json(payload)

    def _send_mcp_json(self, payload):
        self._send_raw(json.dumps(payload, ensure_ascii=False),
                       "application/json; charset=utf-8")

    def _dispatch(self, method: str, path: str, params: dict) -> dict:
        if method == "GET" and path == "/v1/sense":
            return self.api.sense()
        if method == "GET" and path == "/v1/status":
            return self.api.status()
        if method == "GET" and path == "/v1/brain/assess":
            return self.api.assess()
        if method == "GET" and path == "/v1/llm/status":
            return self.api.llm_status()
        if method == "GET" and path == "/v1/events":
            cursor = int((params.get("cursor") or ["0"])[0])
            limit = int((params.get("limit") or ["100"])[0])
            return {"events": self.api.events.read_after(cursor, limit)}
        if method == "GET" and path.startswith("/v1/consensus/"):
            return self.api.consensus_snapshot(path.rsplit("/", 1)[-1])
        if method == "GET" and path.startswith("/v1/distill/"):
            return self.api.distill_status(path.rsplit("/", 1)[-1])
        if method == "GET" and path == "/v1/scene/list":
            limit = int((params.get("limit") or ["100"])[0])
            return self.api.scene_list({"limit": limit})
        if method == "GET" and path.startswith("/v1/scene/"):
            return self.api.scene_get({"session_id": path.rsplit("/", 1)[-1]})
        if method == "GET" and path.startswith("/v1/origins/"):
            return self.api.get_origin(path.rsplit("/", 1)[-1])
        if method == "GET" and path.startswith("/v1/memories/"):
            mem_path = path.split("/")
            if len(mem_path) >= 5 and mem_path[-1] == "origins":
                return self.api.get_memory_origins(mem_path[-2])
            return self.api.get_memory(path.rsplit("/", 1)[-1])
        if method == "GET" and path == "/v1/help":
            return self.api.help()
        if method == "GET" and path == "/v1/doctrines":
            return self.api.doctrines()
        if method == "GET" and path == "/v1/soul":
            return self.api.soul_get()
        if method == "GET" and path.startswith("/v1/logs"):
            lines = int((params.get("lines") or ["50"])[0])
            level = (params.get("level") or [""])[0]
            module = (params.get("module") or [""])[0]
            return self.api.read_logs(lines=lines, level=level, module=module)
        if method == "GET" and path == "/v1/knowledge/topics":
            return self.api.list_knowledge_topics()
        if method == "GET" and path == "/v1/knowledge/all":
            return {"documents": self.api.list_all_knowledge()}
        if method == "GET" and path.startswith("/v1/knowledge"):
            q = (params.get("q") or [""])[0]
            topic = (params.get("topic") or [""])[0]
            pid = (params.get("project_id") or [""])[0]
            scope = (params.get("scope") or [""])[0]
            return {"results": self.api.search_knowledge(
                q, topic=topic, project_id=pid, scope=scope)}
        if method == "GET" and path == "/v1/personal":
            return self.api.get_personal()
        if method == "POST" and path == "/v1/personal":
            payload = self._read_json()
            return self.api.set_personal(payload)
        if method == "POST" and path == "/v1/knowledge":
            payload = self._read_json()
            return self.api.store_knowledge(payload)
        if method == "POST" and path == "/v1/knowledge/distill":
            payload = self._read_json()
            return self.api.distill_knowledge_on_demand(payload)
        if method == "POST" and path == "/v1/distill":
            payload = self._read_json()
            return self.api.distill(payload)
        if method == "POST" and path == "/v1/project/context":
            payload = self._read_json()
            return self.api.project_context(payload)
        if method == "POST" and path == "/v1/project/profile":
            payload = self._read_json()
            action = payload.get("action", "read")
            if action in ("save", "attach") and not self._is_admin():
                raise PermissionError(
                    "admin required for project profile save/attach")
            return self.api.project_profile(payload)
        if method == "POST" and path == "/v1/project/navigate":
            payload = self._read_json()
            return self.api.project_navigate(payload)
        if method == "POST" and path == "/v1/project/harvest":
            payload = self._read_json()
            return self.api.project_harvest(payload)
        if method == "POST" and path == "/v1/code/sync":
            payload = self._read_json()
            return self.api.code_sync(payload)
        if method == "POST" and path == "/v1/harvest/push":
            payload = self._read_json()
            return self.api.harvest_push(payload)
        if method == "POST" and path == "/v1/project/work":
            payload = self._read_json()
            return self.api.project_work(payload)
        if method == "POST" and path == "/v1/project/branch-diff":
            payload = self._read_json()
            return self.api.branch_diff(payload)

        payload = self._read_json()
        if method == "POST" and path == "/v1/agents/register":
            return self.api.register_agent(payload)
        if method == "POST" and path == "/v1/auth/register":
            return self.api.register_user(payload)
        if method == "POST" and path == "/v1/auth/login":
            return self.api.login_user(payload)
        if method == "GET" and path == "/v1/auth/me":
            uid = getattr(self, "current_user", "")
            return {"user_id": uid,
                    "role": "admin" if not uid else "user"}
        if method == "GET" and path == "/v1/auth/users":
            return self.api.auth_users()
        if method == "POST" and path == "/v1/auth/rebind":
            return self.api.rebind_user(payload)
        if method == "POST" and path == "/v1/query":
            return self.api.query(payload)
        if method == "POST" and path == "/v1/search":
            return self.api.search(payload)
        if method == "POST" and path == "/v1/scene/ingest":
            return self.api.scene_ingest(payload)
        if method == "POST" and path == "/v1/scene/compress":
            return self.api.scene_compress(payload)
        if method == "POST" and path == "/v1/scene/delete":
            return self.api.scene_delete(payload)
        if method == "POST" and path == "/v1/scene/distill":
            return self.api.scene_distill(payload)
        if method == "POST" and path == "/v1/skills/append-version":
            return self.api.skill_append_version(payload)
        if method == "POST" and path == "/v1/skills/versions":
            return self.api.skill_versions(payload)
        if method == "POST" and path == "/v1/skills/diff":
            return self.api.skill_diff(payload)
        if method == "POST" and path == "/v1/loadout":
            return self.api.loadout_set(payload)
        if method == "GET" and path == "/v1/loadout":
            return self.api.loadout_get({
                "user": (params.get("user") or [""])[0],
            })
        if method == "POST" and path == "/v1/timeline":
            return self.api.timeline(payload)
        if method == "POST" and path == "/v1/fulltext/rebuild":
            return self.api.rebuild_fulltext()
        if method == "POST" and path == "/v1/memories/propose":
            return self.api.propose_memory(payload)
        if method == "POST" and path == "/v1/soul/set":
            return self.api.soul_set(payload)
        if method == "POST" and path == "/v1/memories/dedup-check":
            return self.api.dedup_check(payload)
        if method == "POST" and path == "/v1/memories/detail":
            return self.api.memory_detail(payload)
        if method == "POST" and path == "/v1/usages/start":
            return self.api.start_usage(payload)
        if method == "POST" and path == "/v1/usages/finish":
            return self.api.finish_usage(payload)
        if method == "POST" and path == "/v1/consensus/vote":
            return self.api.consensus_vote(payload)
        if method == "POST" and path == "/v1/evolve":
            force = (params.get("force") or ["false"])[0].lower() == "true"
            return self.api.evolve(force=force)
        if method == "POST" and path == "/v1/answer":
            return self.api.answer(payload)
        if method == "POST" and path == "/v1/origins/cleanup":
            days_raw = (params.get("days") or ["365"])[0]
            try:
                days = max(int(days_raw), 180)
            except (ValueError, TypeError):
                days = 365
            # 备份目录必须在 /data 下，防止路径遍历
            backup_dir = (params.get("backup_dir") or [
                          "/data/origin_backups"])[0]
            if not backup_dir.startswith("/data/"):
                backup_dir = "/data/origin_backups"
            return self.api.cleanup_expired_origins(days=days, backup_dir=backup_dir)
        if method == "POST" and path == "/v1/batch/process":
            return self.api.batch_process(payload)
        if method == "POST" and path == "/v1/ingest":
            return self._handle_ingest(payload)
        raise RuntimeError(f"unknown endpoint: {method} {path}")

    def _check_auth(self) -> bool:
        """校验 Bearer token（master token 或 user token）。

        - master token（config.server_token）：管理员，user_id=None
        - user token（登录获取）：确定 user_id（物理用户）
        - config.server_token 为空时不鉴权（向后兼容本地开发）
        通过后把身份写入 self.current_user（user_id 或 ""），
        并把 is_admin 置位（master token / 本地开发无鉴权模式）。
        """
        self.current_user = ""
        self.is_admin = False
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            master = config.server_token
            self.is_admin = not master  # 本地开发无 master → 视为管理员
            return not master  # 无 master token 时放行（本地开发）
        token = header[len("Bearer "):].strip()
        # 先查 user token（TOTP 登录下发）
        uid = self.api.auth.resolve(token)
        if uid:
            self.current_user = uid
            return True
        # 再查 master token
        master = config.server_token
        if master and hmac.compare_digest(token, master):
            self.is_admin = True
            return True
        return not master

    def _is_admin(self) -> bool:
        """当前请求是否为管理员（master token / 本地开发无鉴权模式）。"""
        return getattr(self, "is_admin", False)

    @staticmethod
    def _endpoint_requires_admin(method: str, path: str) -> bool:
        """该 (method, path) 是否属于管理端点（普通用户须 403）。"""
        if (method, path) in _ADMIN_ENDPOINTS:
            return True
        if method == "GET" and path.startswith("/v1/logs"):
            return True
        return False

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return self._with_user({})
        raw = self.rfile.read(length).decode("utf-8")
        if not raw.strip():
            return self._with_user({})
        return self._with_user(json.loads(raw))

    def _with_user(self, payload: dict) -> dict:
        """把服务端认证的 user_id 注入 POST payload（_current_user）。
        API 层以此为唯一可信身份（优先于客户端自报的 physical_user，防伪造）。"""
        if isinstance(payload, dict):
            uid = getattr(self, "current_user", "")
            if uid:
                payload["_current_user"] = uid
        return payload

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_raw(self, body: str, content_type: str,
                  status: HTTPStatus = HTTPStatus.OK,
                  extra_headers: Optional[dict] = None):
        """发送裸响应（HTML 等非 JSON 信封）。"""
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _serve_mcp_artifact(self, path: str):
        """从项目根提供 MCP 客户端分发包（mcp.js / install.sh / VERSION）。"""
        root = Path(__file__).resolve().parents[2]  # 容器内 /app
        mapping = {
            "/mcp/mcp.js": ("mcp.js", "text/javascript; charset=utf-8"),
            "/mcp/install.sh": ("scripts/install-mcp.sh",
                                "text/x-shellscript; charset=utf-8"),
            "/mcp/Dockerfile.mcp": ("Dockerfile.mcp",
                                    "text/plain; charset=utf-8"),
            "/mcp/VERSION": ("VERSION", "text/plain; charset=utf-8"),
        }
        if path not in mapping:
            self._send_raw(
                "Cerebrate MCP 分发：\n"
                "  /mcp/mcp.js       Node 版 MCP server\n"
                "  /mcp/install.sh   一键安装脚本\n"
                "  /mcp/VERSION      版本\n",
                "text/plain; charset=utf-8")
            return
        rel, ctype = mapping[path]
        try:
            body = (root / rel).read_text(encoding="utf-8")
        except OSError:
            self._send_json(err("artifact not found", code=404,
                                protocol="v5"), HTTPStatus.NOT_FOUND)
            return
        self._send_raw(body, ctype)

    _sse_semaphore = threading.BoundedSemaphore(5)  # 限制 SSE 并发连接数
    _sse_idle_timeout = 300  # 5 分钟无推送自动断开

    def _handle_sse(self, params: dict):
        cursor = int((params.get("cursor") or ["0"])[0])
        limit = int((params.get("limit") or ["100"])[0])
        once = (params.get("once") or ["false"])[0].lower() == "true"
        if not once:
            if not self._sse_semaphore.acquire(blocking=False):
                self.send_error(503, "Too many SSE connections")
                return
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header(
                "Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            idle_start = time.monotonic()
            while True:
                events = self.api.events.read_after(cursor, limit)
                if events:
                    idle_start = time.monotonic()
                for event in events:
                    cursor = max(cursor, int(event.get("event_id", 0)))
                    frame = (
                        f"id: {event['event_id']}\n"
                        f"event: {event['event_type']}\n"
                        f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    )
                    try:
                        self.wfile.write(frame.encode("utf-8"))
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
                if once:
                    self.close_connection = True
                    return
                # 空闲超时检测
                if time.monotonic() - idle_start > self._sse_idle_timeout:
                    return
                time.sleep(1.0)
        finally:
            if not once:
                self._sse_semaphore.release()

    def _handle_ingest(self, payload: dict) -> dict:
        """处理知识蒸馏吸入请求（POST /v1/ingest）。"""
        from pathlib import Path
        dir_raw = payload.get("dir", "")
        if not dir_raw:
            raise ValueError("缺少必填参数: dir")
        root = Path(dir_raw).resolve()
        if not root.is_dir():
            raise ValueError(f"目录不存在: {root}")
        # 在 Brain Server 进程内直接调用 ingest 模块，Python 环境完整可用
        from cerebrate.tools.ingest import ingest_directory
        return ingest_directory(
            root=root,
            project_id=payload.get("project", ""),
            dry_run=payload.get("dry_run", False),
            verbose=payload.get("verbose", False),
        )


def create_server(host: str = "", port: int = 0, quiet: bool = False) -> ThreadingHTTPServer:
    bind_host = host or config.server_host
    bind_port = config.server_port if port is None else port
    server = BoundedThreadingHTTPServer(
        (bind_host, bind_port), BrainRequestHandler,
        max_workers=config.http_max_threads)
    server.api = BrainAPI()  # type: ignore[attr-defined]
    server.quiet = quiet  # type: ignore[attr-defined]
    return server


def serve(host: str = "", port: int = 0, quiet: bool = False):
    server = create_server(host, port, quiet)
    actual_host, actual_port = server.server_address
    print(json.dumps(ok({
        "base_url": f"http://{actual_host}:{actual_port}",
    }, protocol="v5"), ensure_ascii=False), flush=True)

    # ── 启动后台调度器（自动进化 + 原始记忆清理）──
    try:
        from cerebrate.server.scheduler import start_scheduler
        start_scheduler(server.api)
    except Exception:
        pass  # 调度器非关键路径，启动失败不影响主服务

    # ── 预热 sense 缓存 ──
    # 首次 sense 需冷加载 embedding/consensus（~30s）；后台预热填 _sense_cache，
    # 避免 healthcheck 与首个请求并发触发初始化导致锁竞争（表现为服务"卡死"）。
    def _warmup_sense(api):
        import time as _time
        _time.sleep(5)
        try:
            api.sense()
        except Exception:
            pass

    threading.Thread(target=_warmup_sense, args=(server.api,),
                     daemon=True, name="cerebrate-warmup").start()

    # 忽略 SIGPIPE，防止客户端断连时进程退出
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

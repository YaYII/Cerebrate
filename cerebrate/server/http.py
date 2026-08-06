"""HTTP transport for the authoritative Cerebrate Brain Server."""

import json
import signal
import threading
import time
import hmac
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from cerebrate.config import config
from cerebrate.protocol import err, ok
from cerebrate.server.api import BrainAPI


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
            # 登录免认证：用户输入 TOTP 时尚未持有 token
            if method == "POST" and path == "/v1/auth/login":
                data = self._dispatch(method, path, parse_qs(parsed.query))
                self._send_json(ok(data, protocol="v5"))
                return
            if not self._check_auth():
                self._send_json(err("unauthorized", code=401, protocol="v5"),
                                HTTPStatus.UNAUTHORIZED)
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
        except ValueError as e:
            self._send_json(err(str(e), code=400, protocol="v5"),
                            HTTPStatus.BAD_REQUEST)
        except Exception as e:
            self._send_json(err(str(e), code=500, protocol="v5",
                                exception=e.__class__.__name__),
                            HTTPStatus.INTERNAL_SERVER_ERROR)

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
        if method == "GET" and path == "/v1/auth/users":
            return self.api.auth_users()
        if method == "POST" and path == "/v1/query":
            return self.api.query(payload)
        if method == "POST" and path == "/v1/search":
            return self.api.search(payload)
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
        通过后把身份写入 self.current_user（user_id 或 ""）。
        """
        self.current_user = ""
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            master = config.server_token
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
            return True
        return not master

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        if not raw.strip():
            return {}
        return json.loads(raw)

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

    # 忽略 SIGPIPE，防止客户端断连时进程退出
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

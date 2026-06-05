"""HTTP transport for the authoritative Cerebrate Brain Server."""

import json
import signal
import threading
import time
import hmac
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from cerebrate.config import config
from cerebrate.protocol import err, ok
from cerebrate.server.api import BrainAPI


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
            if not self._check_auth():
                self._send_json(err("unauthorized", code=401, protocol="v5"),
                                HTTPStatus.UNAUTHORIZED)
                return
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
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
        if method == "GET" and path == "/v1/knowledge/topics":
            return self.api.list_knowledge_topics()
        if method == "GET" and path == "/v1/knowledge/all":
            return {"documents": self.api.list_all_knowledge()}
        if method == "GET" and path.startswith("/v1/knowledge"):
            q = (params.get("q") or [""])[0]
            topic = (params.get("topic") or [""])[0]
            pid = (params.get("project_id") or [""])[0]
            return {"results": self.api.search_knowledge(q, topic=topic, project_id=pid)}
        if method == "GET" and path == "/v1/personal":
            return self.api.get_personal()
        if method == "POST" and path == "/v1/personal":
            payload = self._read_json()
            return self.api.set_personal(payload)
        if method == "POST" and path == "/v1/knowledge":
            payload = self._read_json()
            return self.api.store_knowledge(payload)

        payload = self._read_json()
        if method == "POST" and path == "/v1/agents/register":
            return self.api.register_agent(payload)
        if method == "POST" and path == "/v1/query":
            return self.api.query(payload)
        if method == "POST" and path == "/v1/memories/propose":
            return self.api.propose_memory(payload)
        if method == "POST" and path == "/v1/usages/start":
            return self.api.start_usage(payload)
        if method == "POST" and path == "/v1/usages/finish":
            return self.api.finish_usage(payload)
        if method == "POST" and path == "/v1/consensus/vote":
            return self.api.consensus_vote(payload)
        if method == "POST" and path == "/v1/evolve":
            force = (params.get("force") or ["false"])[0].lower() == "true"
            return self.api.evolve(force=force)
        if method == "POST" and path == "/v1/origins/cleanup":
            days_raw = (params.get("days") or ["365"])[0]
            try:
                days = max(int(days_raw), 180)
            except (ValueError, TypeError):
                days = 365
            # 备份目录必须在 /data 下，防止路径遍历
            backup_dir = (params.get("backup_dir") or ["/data/origin_backups"])[0]
            if not backup_dir.startswith("/data/"):
                backup_dir = "/data/origin_backups"
            return self.api.cleanup_expired_origins(days=days, backup_dir=backup_dir)
        if method == "POST" and path == "/v1/batch/process":
            return self.api.batch_process(payload)
        raise RuntimeError(f"unknown endpoint: {method} {path}")

    def _check_auth(self) -> bool:
        """校验 Bearer token。config.server_token 为空时不鉴权（向后兼容本地开发）。"""
        token = config.server_token
        if not token:
            return True
        header = self.headers.get("Authorization", "")
        return hmac.compare_digest(header, f"Bearer {token}")

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


def create_server(host: str = "", port: int = 0, quiet: bool = False) -> ThreadingHTTPServer:
    bind_host = host or config.server_host
    bind_port = config.server_port if port is None else port
    server = ThreadingHTTPServer((bind_host, bind_port), BrainRequestHandler)
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

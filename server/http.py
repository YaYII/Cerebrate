"""HTTP transport for the authoritative Cerebrate Brain Server."""

import json
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from config import config
from protocol import err, ok
from .api import BrainAPI


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
            params = parse_qs(parsed.query)
            if path == "/v1/events/stream" and method == "GET":
                self._handle_sse(params)
                return
            data = self._dispatch(method, path, params)
            self._send_json(ok(data, protocol="v5"))
        except KeyError as e:
            self._send_json(err(str(e), code=404, protocol="v5"), HTTPStatus.NOT_FOUND)
        except ValueError as e:
            self._send_json(err(str(e), code=400, protocol="v5"), HTTPStatus.BAD_REQUEST)
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
        if method == "GET" and path.startswith("/v1/memories/"):
            return self.api.get_memory(path.rsplit("/", 1)[-1])
        if method == "GET" and path == "/v1/help":
            return self.api.help()
        if method == "GET" and path == "/v1/doctrines":
            return self.api.doctrines()

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
            return self.api.evolve()
        raise KeyError(f"unknown endpoint: {method} {path}")

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
        self.wfile.write(body)

    def _handle_sse(self, params: dict):
        cursor = int((params.get("cursor") or ["0"])[0])
        limit = int((params.get("limit") or ["100"])[0])
        once = (params.get("once") or ["false"])[0].lower() == "true"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        while True:
            events = self.api.events.read_after(cursor, limit)
            for event in events:
                cursor = max(cursor, int(event.get("event_id", 0)))
                frame = (
                    f"id: {event['event_id']}\n"
                    f"event: {event['event_type']}\n"
                    f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                )
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
            if once:
                self.close_connection = True
                return
            time.sleep(1.0)


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
        "host": actual_host,
        "port": actual_port,
        "base_url": f"http://{actual_host}:{actual_port}",
    }, protocol="v5"), ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

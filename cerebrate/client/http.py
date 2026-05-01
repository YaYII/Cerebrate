"""HTTP client for Cerebrate Brain Server."""

import json
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import config
from ..protocol import err


class BrainClient:
    """Small client used by CLI/agent adapters to call the Brain Server."""

    def __init__(self, base_url: Optional[str] = None, timeout: float = 30.0):
        self.base_url = (base_url or config.server_url or "http://127.0.0.1:8765").rstrip("/")
        self.timeout = timeout

    def get(self, path: str, params: Optional[dict] = None) -> dict:
        query = f"?{urlencode(params)}" if params else ""
        return self._request("GET", f"{path}{query}")

    def post(self, path: str, payload: Optional[dict] = None) -> dict:
        return self._request("POST", path, payload or {})

    def _request(self, method: str, path: str, payload: Optional[dict] = None) -> dict:
        url = f"{self.base_url}{path}"
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as e:
            raw = e.read().decode("utf-8")
        except URLError as e:
            return err(f"Brain Server unavailable: {e.reason}", code=503, protocol="v5")
        return json.loads(raw)

"""文件系统 IPC — AI 智能体通过 JSON 文件与 Cerebrate 交互

AI 智能体无需启动 HTTP 服务，直接写入命令文件到队列目录。
Cerebrate 批处理器扫描并处理请求，写入结果文件。
"""
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import config
from .storage.atomic import atomic_write_json


class BatchProcessor:
    """批处理器 — 扫描请求队列，逐个处理命令"""

    def __init__(self, memory_manager, queue_path: Optional[Path] = None):
        self.mm = memory_manager
        self.queue_path = queue_path or config.queue_path
        self.requests_path = self.queue_path / "requests"
        self.results_path = self.queue_path / "results"
        self.processed_path = self.queue_path / "processed"
        for p in [self.requests_path, self.results_path, self.processed_path]:
            p.mkdir(parents=True, exist_ok=True)

    def submit(self, source_agent: str, command: str, params: dict,
               project_id: str = "") -> str:
        """提交一个命令到请求队列"""
        import uuid
        request_id = str(uuid.uuid4())[:8]
        now = datetime.now(timezone.utc).isoformat()

        request = {
            "request_id": request_id,
            "timestamp": now,
            "source_agent": source_agent,
            "project_id": project_id or config.current_project_id,
            "command": command,
            "params": params,
        }
        req_file = self.requests_path / f"{request_id}.json"
        req_file.write_text(json.dumps(request, ensure_ascii=False, indent=2))
        return request_id

    def get_result(self, request_id: str) -> Optional[dict]:
        """获取请求结果"""
        result_file = self.results_path / f"{request_id}.result.json"
        if result_file.exists():
            return json.loads(result_file.read_text())
        return None

    def process_pending(self, limit: int = 50) -> int:
        """处理所有待处理请求，返回处理数量"""
        req_files = sorted(self.requests_path.glob("*.json"))
        processed = 0

        for req_file in req_files[:limit]:
            try:
                result = self._process_one(req_file)
                result_file = self.results_path / f"{result['request_id']}.result.json"
                atomic_write_json(result_file, result)
                req_file.rename(self.processed_path / req_file.name)
                processed += 1
            except Exception as e:
                # 写入错误结果
                try:
                    req_data = json.loads(req_file.read_text())
                    rid = req_data.get("request_id", req_file.stem)
                    error_result = {
                        "request_id": rid, "status": "error",
                        "error": str(e), "elapsed_ms": 0,
                    }
                    result_file = self.results_path / f"{rid}.result.json"
                    atomic_write_json(result_file, error_result)
                    req_file.rename(self.processed_path / req_file.name)
                except Exception:
                    pass
        return processed

    def _process_one(self, req_file: Path) -> dict:
        start = time.time()
        request = json.loads(req_file.read_text())
        rid = request.get("request_id", req_file.stem)
        command = request.get("command", "")
        params = request.get("params", {})
        user_id = params.get("user_id", request.get("source_agent", "default"))

        result = {"request_id": rid, "status": "ok", "data": None}

        try:
            if command == "query":
                result["data"] = self.mm.query_swarm(
                    query_text=params.get("query", ""),
                    category=params.get("category"),
                    tags=params.get("tags"),
                    limit=params.get("limit", 10),
                    project_id=params.get("project_id"),
                    source_agent=params.get("source_agent"),
                )
            elif command == "share":
                result["data"] = {"memory_id": self.mm.share_to_swarm(
                    title=params.get("title", ""),
                    content=params.get("content", ""),
                    category=params.get("category", "general"),
                    tags=params.get("tags", []),
                    source_agent=request.get("source_agent", "unknown"),
                    problem_solved=params.get("problem_solved", ""),
                    solution=params.get("solution", ""),
                    outcome=params.get("outcome", "success"),
                    project_id=params.get("project_id", ""),
                )}
            elif command == "remember":
                self.mm.remember_user(
                    user_id=user_id,
                    key=params.get("key", ""),
                    value=params.get("value", ""),
                    confidence=params.get("confidence", 1.0),
                    project_id=params.get("project_id", ""),
                )
                result["data"] = {"remembered": True}
            elif command == "recall":
                result["data"] = self.mm.recall_user(
                    user_id=user_id, key=params.get("key"),
                )
            elif command == "store-kb":
                result["data"] = {"doc_id": self.mm.store_knowledge(
                    title=params.get("title", ""),
                    content=params.get("content", ""),
                    source=params.get("source", ""),
                    topics=params.get("topics", []),
                    is_policy=params.get("is_policy", False),
                    policy_name=params.get("policy_name", ""),
                    project_id=params.get("project_id", ""),
                )}
            elif command == "stats":
                result["data"] = self.mm.get_all_stats()
            elif command == "sense":
                from .brain.self_awareness import CerebrateMind
                mind = CerebrateMind(self.mm)
                result["data"] = mind.sense()
            elif command == "evolve":
                from .memory.evolution import EvolutionEngine
                engine = EvolutionEngine(config.evolution_path, self.mm)
                result["data"] = engine.evolve()
            elif command == "register":
                result["data"] = self.mm.register_agent(
                    agent_id=params.get("agent_id", request.get("source_agent", "")),
                    agent_type=params.get("agent_type", "cli"),
                    capabilities=params.get("capabilities"),
                    metadata=params.get("metadata"),
                )
            else:
                result["status"] = "error"
                result["error"] = f"未知命令: {command}"
        except Exception as e:
            result["status"] = "error"
            result["error"] = str(e)

        result["elapsed_ms"] = int((time.time() - start) * 1000)
        return result

    def clean_processed(self, keep_days: int = 7):
        """清理超过 N 天的已处理请求"""
        cutoff = time.time() - keep_days * 86400
        for f in self.processed_path.glob("*.json"):
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
        for f in self.results_path.glob("*.json"):
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)

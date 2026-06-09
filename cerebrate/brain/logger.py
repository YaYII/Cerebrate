"""虫群运行日志 — 结构化的 JSON 行日志

写入路径: {logs_path}/cerebrate.log
每行一个 JSON 对象，包含:
  - timestamp: ISO 时间
  - level: INFO / WARNING / ERROR
  - module: 模块名（evolution / scheduler / api / system）
  - action: 操作类型（evolve / distill / cleanup / start / stop）
  - message: 可读描述
  - details: 额外结构化数据（可选）

读取: 支持 tail、按级别/模块/时间过滤
"""
import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


class CerebrateLogger:
    """虫群结构化日志写入器。

    线程安全，每写一行 flush一次，确保容器崩溃不丢最后几行。
    """

    def __init__(self, log_path: Path):
        self._log_path = log_path
        self._lock = threading.Lock()
        os.makedirs(log_path, exist_ok=True)
        self._file_path = log_path / "cerebrate.log"
        self._std_logger = logging.getLogger("cerebrate.log")

    def _write(self, level: str, module: str, action: str, message: str,
               details: Optional[dict] = None):
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "module": module,
            "action": action,
            "message": message,
        }
        if details:
            entry["details"] = details

        line = json.dumps(entry, ensure_ascii=False)
        with self._lock:
            try:
                with open(self._file_path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
                    f.flush()
            except OSError as e:
                self._std_logger.error(f"日志写入失败: {e}")

    def info(self, module: str, action: str, message: str, details: Optional[dict] = None):
        self._write("INFO", module, action, message, details)

    def warning(self, module: str, action: str, message: str, details: Optional[dict] = None):
        self._write("WARNING", module, action, message, details)

    def error(self, module: str, action: str, message: str, details: Optional[dict] = None):
        self._write("ERROR", module, action, message, details)

    def read_tail(self, lines: int = 50,
                  level: Optional[str] = None,
                  module: Optional[str] = None) -> list[dict]:
        """读取最近的日志条目，支持按级别/模块过滤。"""
        if not self._file_path.exists():
            return []

        results = []
        try:
            with self._lock:
                with open(self._file_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if level and entry.get("level") != level:
                            continue
                        if module and entry.get("module") != module:
                            continue
                        results.append(entry)
        except OSError:
            return []

        return results[-lines:]

    def read_by_module(self, module: str, lines: int = 50) -> list[dict]:
        return self.read_tail(lines=lines, module=module)

    def read_by_level(self, level: str, lines: int = 50) -> list[dict]:
        return self.read_tail(lines=lines, level=level)


# 全局单例
_logger: Optional[CerebrateLogger] = None
_lock = threading.Lock()


def get_logger(log_path: Optional[Path] = None) -> CerebrateLogger:
    """获取全局日志器单例。"""
    global _logger
    if _logger is None:
        with _lock:
            if _logger is None:
                from cerebrate.config import config
                path = log_path or config.logs_path
                _logger = CerebrateLogger(path)
    return _logger

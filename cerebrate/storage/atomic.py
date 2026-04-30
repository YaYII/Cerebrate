"""原子文件操作 — 多进程安全的 JSON 写入"""
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Optional


def atomic_write_json(path: Path, data: dict, indent: int = 2) -> None:
    """原子写入 JSON 文件: 写临时文件 → fsync → os.replace"""
    tmp_fd, tmp_path = tempfile.mkstemp(
        suffix=".tmp", prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        os.unlink(tmp_path)
        raise
    os.replace(tmp_path, path)


class FileLock:
    """基于 O_CREAT | O_EXCL 的文件 advisory lock"""

    def __init__(self, lock_path: Path, timeout: float = 5.0):
        self.lock_path = lock_path
        self.timeout = timeout
        self._fd: Optional[int] = None

    def __enter__(self):
        deadline = time.time() + self.timeout
        while True:
            try:
                self._fd = os.open(
                    str(self.lock_path),
                    os.O_CREAT | os.O_EXCL | os.O_RDWR,
                )
                return self
            except FileExistsError:
                if time.time() > deadline:
                    raise TimeoutError(
                        f"无法在 {self.timeout}s 内获取锁: {self.lock_path}"
                    )
                time.sleep(0.05)

    def __exit__(self, *args):
        if self._fd is not None:
            os.close(self._fd)
            try:
                os.unlink(str(self.lock_path))
            except OSError:
                pass


def locked_atomic_write(path: Path, data: dict, timeout: float = 5.0) -> None:
    """带文件锁的原子写入"""
    lock_path = Path(str(path) + ".lock")
    with FileLock(lock_path, timeout):
        atomic_write_json(path, data)

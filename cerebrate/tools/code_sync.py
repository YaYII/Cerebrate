"""
代码同步：把本地项目完整代码同步到脑虫服务器（企业级画像的真实代码源）。.

问题: 脑虫运行在服务器（Docker 容器），用户代码在本地，harvest 无法直接读取。
方案: 本地 CLI 打包上传 → 服务器解压到 {memory_root}/code_repos/{project_id}/ → 自动 harvest（AST）。

安全（双端防御）:
  - 本地打包排除敏感文件（.env/密钥/证书/凭据/私有笔记/数据目录）
  - 服务器解压校验路径穿越（拒绝绝对路径/..//符号链接逃逸）+ 敏感文件兜底
"""

import base64
import hashlib
import io
import json
import logging
import os
import re
import subprocess
import tarfile
from datetime import UTC, datetime
from pathlib import Path

from cerebrate.config import config

logger = logging.getLogger(__name__)

# 同步排除：目录（.git/node_modules/数据/缓存/敏感配置）
SYNC_EXCLUDE_DIRS = {
    ".git", "__pycache__", ".venv", "venv", "node_modules", "vendor",
    "dist", "build", ".idea", ".vscode", ".codex", ".qoder", ".claude",
    "data", "profiles", "harvest", "context", "chroma_data", "docstore",
    "knowledge_files", "knowledge", "logs", "events", "personal", "agents",
    "evolution", "swarm", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".next", ".nuxt", "target", "out",
}
# 同步排除：敏感文件（含通配匹配前缀）
SYNC_EXCLUDE_FILES = {
    ".env", ".env.local", ".env.production", "private_notes.md",
    "credentials.json", "service_account.json", "id_rsa", "id_ed25519",
    ".npmrc", ".pypirc", ".netrc", "config.json",
}
SYNC_EXCLUDE_SUFFIXES = (
    ".pem", ".key", ".p12", ".pfx", ".sqlite3", ".db", ".log", ".pyc",
    ".tar", ".gz", ".zip", ".7z", ".jpg", ".jpeg", ".png", ".gif", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".class", ".jar", ".lock",
    ".min.js", ".min.css", ".map",
)
SYNC_EXCLUDE_NAME_TOKENS = ("token", "secret", "credential", "private", "password")

# 本地同步清单缓存目录（不污染项目目录）
SYNC_CACHE_DIR = Path(
    os.environ.get("CEREBRATE_SYNC_CACHE", str(Path.home() / ".cerebrate-sync")))

# 分支数量上限（超限保留最近 N 个，默认分支总是保留）
SYNC_MAX_BRANCHES = int(os.environ.get("CEREBRATE_SYNC_MAX_BRANCHES", "20"))


def _safe_branch(branch: str) -> str:
    b = re.sub(r"[^0-9a-zA-Z._-]+", "-", str(branch or "").strip())
    b = b.strip(".-")
    return b or "default"


def _git_branch(root: Path) -> str:
    """从 git 仓库推断当前分支；非 git 仓库返回 default。."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "branch", "--show-current"],
            capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return _safe_branch(out.stdout.strip())
    except Exception:
        pass
    return "default"


def _repo_root(project_id: str, branch: str = "") -> Path:
    """代码仓根：分支版 code_repos/{project_id}/{branch}；无分支兼容旧路径。."""
    base = config.memory_root / "code_repos" / project_id
    if not branch:
        return base
    return base / _safe_branch(branch)


def _meta_path(project_id: str) -> Path:
    # 分支登记统一放 harvest 目录（代码不落服务端时同样可用）
    return config.memory_root / "harvest" / project_id / ".meta.json"


def _load_meta(project_id: str) -> dict:
    p = _meta_path(project_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    # 兼容旧路径（code_repos 时代）
    legacy = (config.memory_root / "code_repos" / project_id / ".meta.json")
    if legacy.exists():
        try:
            return json.loads(legacy.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"branches": {}, "default_branch": "default"}


def _save_meta(project_id: str, meta: dict) -> None:
    p = _meta_path(project_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    tmp.replace(p)


def _is_sensitive_path(rel: str) -> str | None:
    """返回敏感原因（None=安全）。文件名级判断。."""
    parts = rel.replace("\\", "/").split("/")
    name = parts[-1].lower()
    for d in parts[:-1]:
        if d in SYNC_EXCLUDE_DIRS:
            return f"目录被排除: {d}"
    if name in SYNC_EXCLUDE_FILES:
        return f"敏感文件: {name}"
    if name.endswith(SYNC_EXCLUDE_SUFFIXES):
        return f"扩展名排除: {Path(name).suffix}"
    for tok in SYNC_EXCLUDE_NAME_TOKENS:
        if tok in name:
            return f"含敏感标识: {tok}"
    return None


def _sha256(filepath: Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _manifest_path(project_id: str) -> Path:
    SYNC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return SYNC_CACHE_DIR / f"{project_id}.json"


def _load_manifest(project_id: str) -> dict | None:
    p = _manifest_path(project_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_manifest(project_id: str, manifest: dict) -> None:
    p = _manifest_path(project_id)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    tmp.replace(p)


def _scan_files_with_hash(root: Path) -> tuple[list[tuple[str, int]], list[dict]]:
    """扫描目录，返回 (files: [(rel, size)], excluded)。."""
    files, excluded = [], []
    for filepath in sorted(root.rglob("*")):
        if not filepath.is_file():
            continue
        rel = str(filepath.relative_to(root)).replace("\\", "/")
        reason = _is_sensitive_path(rel)
        if reason:
            excluded.append({"path": rel, "reason": reason})
            continue
        try:
            size = filepath.stat().st_size
        except OSError:
            continue
        files.append((rel, size))
    return files, excluded


def build_package(root: Path, project_id: str = "",
                  max_bytes: int = 0, incremental: bool = True,
                  branch: str = "") -> dict:
    """本地打包：扫描目录生成 tar.gz（排除敏感），支持增量（只传变更文件）。."""
    root = root.resolve()
    branch = _safe_branch(branch or _git_branch(root))
    max_bytes = max_bytes or config.code_sync_max_bytes
    files, excluded = _scan_files_with_hash(root)
    total = 0
    current_hash: dict[str, str] = {}
    for rel, size in files:
        total += size
        current_hash[rel] = _sha256(root / rel)
    if total > max_bytes:
        raise ValueError(
            f"代码包 {total/1024/1024:.1f}MB 超过上限 {max_bytes/1024/1024:.0f}MB，"
            f"请排除大目录后重试")

    prev = _load_manifest(project_id) if incremental else None
    if prev and prev.get("root") == str(root):
        # 增量：变更 + 新增 + 删除
        changed = [rel for rel, h in current_hash.items()
                   if prev.get("files", {}).get(rel) != h]
        added = [rel for rel in current_hash
                 if rel not in prev.get("files", {})]
        deleted = [rel for rel in prev.get("files", {})
                   if rel not in current_hash]
        to_pack = sorted(set(changed) | set(added))
        incremental_used = True
    else:
        to_pack = [rel for rel, _ in files]
        deleted = []
        incremental_used = False

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for rel in to_pack:
            tf.add(root / rel, arcname=rel)
    package_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    # 更新本地清单（记录当前全量状态）
    _save_manifest(project_id, {
        "project_id": project_id,
        "root": str(root),
        "files": current_hash,
        "synced_at": datetime.now(UTC).isoformat(),
    })
    return {
        "project_id": project_id,
        "root": str(root),
        "branch": branch,
        "incremental": incremental_used,
        "files_total": len(files),
        "files_changed": len(to_pack),
        "files_deleted": len(deleted),
        "deleted": deleted,
        "files_count": len(to_pack),
        "excluded_count": len(excluded),
        "total_bytes": total,
        "package_bytes": len(buf.getvalue()),
        "package_b64": package_b64,
        "files": [{"path": p, "size": s} for p, s in files if p in set(to_pack)],
        "excluded": excluded[:100],
    }


def _safe_extract(tar_bytes: bytes, dest: Path) -> int:
    """安全解压：拒绝绝对路径/../、符号链接逃逸，跳过敏感文件。."""
    dest = dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    try:
        tf = tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz")
    except tarfile.TarError as e:
        raise ValueError(f"无效或空的代码包: {e}")
    with tf:
        for member in tf.getmembers():
            name = member.name.replace("\\", "/")
            # 路径穿越防御
            target = (dest / name).resolve()
            if not str(target).startswith(str(dest) + "/") and target != dest:
                logger.warning("拒绝越界路径: %s", name)
                continue
            if name.startswith("/") or name.startswith(".."):
                logger.warning("拒绝非法路径: %s", name)
                continue
            if member.issym() or member.islnk():
                logger.warning("拒绝链接: %s", name)
                continue
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            reason = _is_sensitive_path(name)
            if reason:
                logger.warning("服务端跳过敏感文件 %s (%s)", name, reason)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            src = tf.extractfile(member)
            if src is None:
                continue
            with open(target, "wb") as f:
                f.write(src.read())
            count += 1
    return count


def _safe_remove(repo_root: Path, rel: str) -> bool:
    """安全删除代码仓内文件（拒绝路径穿越）。."""
    target = (repo_root / rel).resolve()
    if not str(target).startswith(str(repo_root) + "/"):
        logger.warning("拒绝删除越界路径: %s", rel)
        return False
    if target.is_file():
        target.unlink(missing_ok=True)
        return True
    return False


def receive_package(project_id: str, package_b64: str,
                    branch: str = "",
                    delete_list: list | None = None,
                    auto_harvest: bool = True) -> dict:
    """服务端接收：解压代码仓（增量应用删除清单）→ 可选自动 harvest。."""
    branch = _safe_branch(branch)
    try:
        tar_bytes = base64.b64decode(package_b64)
    except Exception as e:
        raise ValueError(f"package_b64 解码失败: {e}")
    if len(tar_bytes) > config.code_sync_max_bytes:
        raise ValueError(f"代码包 {len(tar_bytes)/1024/1024:.1f}MB 超过上限 "
                         f"{config.code_sync_max_bytes/1024/1024:.0f}MB")
    repo_root = _repo_root(project_id, branch)
    written = _safe_extract(tar_bytes, repo_root)
    removed = 0
    for rel in (delete_list or []):
        if _safe_remove(repo_root, rel):
            removed += 1
    result = {
        "project_id": project_id,
        "branch": branch,
        "repo_path": str(repo_root),
        "files_written": written,
        "files_removed": removed,
        "received_bytes": len(tar_bytes),
    }
    if auto_harvest:
        from cerebrate.tools.code_harvest import harvest_project, save_harvest
        try:
            h = harvest_project(repo_root, project_id=project_id)
            save_harvest(h, branch=branch)
            result["harvest"] = h.get("stats", {})
        except Exception as e:
            result["harvest_error"] = str(e)
    # 更新分支 meta（最近同步 + 分支清单，超限清理）
    meta = _load_meta(project_id)
    meta.setdefault("default_branch", branch)
    meta["branches"][branch] = {
        "last_synced": datetime.now(UTC).isoformat(),
        "files": written,
        "harvest": result.get("harvest", {}),
    }
    # 分支上限清理：保留最近 N 个 + 默认分支
    default_b = meta["default_branch"]
    branches = sorted(
        meta["branches"].items(),
        key=lambda kv: kv[1].get("last_synced", ""), reverse=True)
    keep = []
    for b, info in branches:
        if b == default_b or len(keep) < SYNC_MAX_BRANCHES:
            keep.append((b, info))
    for b, _info in branches[len(keep):]:
        if b != default_b:
            meta["branches"].pop(b, None)
            # 删除该分支代码仓与 harvest
            _remove_tree(repo_root.parent / b)
            (config.memory_root / "harvest" / project_id /
             f"{b}.json").unlink(missing_ok=True)
    _save_meta(project_id, meta)
    result["branches"] = sorted(meta["branches"].keys())
    return result


def _remove_tree(path: Path) -> None:
    """安全递归删除目录（分支清理用）。."""
    if not path.exists():
        return
    for child in sorted(path.rglob("*"), reverse=True):
        if child.is_file() or child.is_symlink():
            child.unlink(missing_ok=True)
    path.rmdir()


def list_branches(project_id: str) -> dict:
    """列出项目已同步分支 + 各自 harvest 统计。."""
    meta = _load_meta(project_id)
    branches = []
    for b, info in sorted(meta.get("branches", {}).items()):
        branches.append({"branch": b, **info})
    return {
        "project_id": project_id,
        "default_branch": meta.get("default_branch", "default"),
        "branches": branches,
    }

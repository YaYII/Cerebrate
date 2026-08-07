#!/usr/bin/env python3
"""cerebrate/tools/ingest.py — 企业知识蒸馏入脑虫

将本地文档目录批量吸入脑虫权威知识库（KnowledgeBase）。

工作流程:
  1. 递归扫描目录，找到 .md / .txt 文件
  2. 按 .gitignore 模式过滤
  3. SHA256 文件级别去重检测
  4. 大文件按二级标题 (## ) 智能分块
  5. 每块通过 POST /v1/knowledge 写入脑虫知识库
  6. 输出吸入报告（新增/跳过/失败）

用法:
  python3 -m cerebrate.tools.ingest --dir ./docs --project my-project
  python3 -m cerebrate.tools.ingest --dir ./docs --dry-run  # 预览
  python3 -m cerebrate.tools.ingest --dir ./docs --verbose

依赖:
  - urllib（标准库，零额外依赖）
  - pathspec（可选，用于支持 .gitignore 模式匹配）
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


# 所有面向人的输出走 stderr，stdout 仅输出 JSON
def _echo(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

# ── HTTP 客户端 ────────────────────────────────────────────

_SERVER_URL = os.environ.get("CEREBRATE_SERVER_URL", "http://127.0.0.1:8765")
_SERVER_TOKEN = os.environ.get("CEREBRATE_SERVER_TOKEN", "")
_PHYSICAL_USER = os.environ.get("USER") or os.environ.get("LOGNAME") or "unknown"


def _api_post(path: str, body: dict) -> dict:
    """调用脑虫 API POST 接口，返回 v5 协议 JSON。"""
    full_url = _SERVER_URL.rstrip("/") + path
    headers = {"Content-Type": "application/json"}
    if _SERVER_TOKEN:
        headers["Authorization"] = f"Bearer {_SERVER_TOKEN}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(full_url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8") if e.fp else "{}"
        try:
            return json.loads(err_body)
        except json.JSONDecodeError:
            return {"status": "error", "error": {"code": e.code, "message": err_body}}
    except urllib.error.URLError as e:
        return {"status": "error", "error": {"code": 503,
                "message": f"无法连接脑虫服务 {full_url}: {e.reason}"}}


# ── 文件扫描 ───────────────────────────────────────────────

# 支持的文件类型（可扩展）
SUPPORTED_EXTENSIONS = {".md", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml", ".cfg", ".ini"}

# 默认排除的目录/文件模式
DEFAULT_EXCLUDE_DIRS = {".git", "__pycache__", ".pytest_cache", "node_modules",
                        ".venv", "venv", ".codegraph", ".deepseek",
                        ".claude", ".idea", ".vscode", "dist", "build",
                        ".虫群", "memory", ".archived"}

DEFAULT_EXCLUDE_FILES = {"mcp.json", ".env", "package-lock.json", "yarn.lock",
                         ".ingest_cache.json"}


def _load_gitignore_patterns(root: Path) -> list:
    """加载 .gitignore 中的模式（使用 pathspec 库，如不可用则回退简单规则）。"""
    patterns = []
    gitignore_path = root / ".gitignore"
    if gitignore_path.exists():
        try:
            import pathspec
            with open(gitignore_path, "r", encoding="utf-8") as f:
                spec = pathspec.PathSpec.from_lines(
                    pathspec.patterns.GitWildMatchPattern, f
                )
            return spec
        except ImportError:
            # 没有 pathspec 库，逐行读取做基础过滤
            with open(gitignore_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        patterns.append(line)
    return patterns


def _is_excluded_by_gitignore(file_rel: str, patterns) -> bool:
    """检查相对路径是否匹配 .gitignore 规则。"""
    if hasattr(patterns, "match_file"):
        return patterns.match_file(file_rel)
    # 回退：简单的后缀/前缀匹配
    for pat in patterns:
        if pat.startswith("/"):
            if file_rel == pat[1:]:
                return True
        elif pat.endswith("/"):
            if file_rel.startswith(pat) or f"/{file_rel}".startswith(f"/{pat}"):
                return True
        elif "*" in pat:
            import fnmatch
            if fnmatch.fnmatch(file_rel, pat):
                return True
        else:
            if file_rel == pat or file_rel.endswith("/" + pat):
                return True
    return False


def scan_files(root: Path, verbose: bool = False) -> list[Path]:
    """递归扫描目录，返回所有支持的文件列表（已过滤排除项）。"""
    gitignore_patterns = _load_gitignore_patterns(root)
    files = []

    for filepath in sorted(root.rglob("*")):
        if not filepath.is_file():
            continue

        # 按扩展名过滤
        if filepath.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue

        # 检查父目录排除
        rel = filepath.relative_to(root)
        parts = rel.parts
        skip = False
        for part in parts[:-1]:
            if part in DEFAULT_EXCLUDE_DIRS:
                skip = True
                break
        if skip:
            continue

        # 检查文件名排除
        if filepath.name in DEFAULT_EXCLUDE_FILES:
            continue

        # 检查 .gitignore
        rel_str = str(rel).replace("\\", "/")
        if gitignore_patterns and _is_excluded_by_gitignore(rel_str, gitignore_patterns):
            if verbose:
                _echo(f"  ⏭  .gitignore 跳过: {rel_str}")
            continue

        files.append(filepath)

    return files


# ── 文档分块 ──────────────────────────────────────────────

# 单块最大行数（超过则强制按标题切分）
MAX_CHUNK_LINES = 300


def chunk_document(filepath: Path) -> list[dict]:
    """将文件拆分为知识块。

    返回: [{title, content, tags, source}]
    """
    content = filepath.read_text(encoding="utf-8", errors="replace")
    lines = content.split("\n")
    total_lines = len(lines)

    # 从路径自动提取标签
    rel = filepath.relative_to(filepath.anchor if filepath.is_absolute() else Path.cwd())
    path_tags = [p for p in rel.parts if p not in DEFAULT_EXCLUDE_DIRS
                 and not p.startswith(".") and not p.startswith("_")]
    # 去掉文件扩展名作为标签
    stem_tag = filepath.stem.lower().replace(" ", "-").replace("_", "-")

    source = str(filepath.resolve())

    # ── 小文件：单块 ──
    if total_lines <= MAX_CHUNK_LINES:
        title = _infer_title(content, filepath.stem)
        return [{
            "title": title,
            "content": content.strip(),
            "tags": path_tags + [stem_tag],
            "source": source,
        }]

    # ── 大文件：按二级标题分块 ──
    chunks = []
    current_lines = []
    current_title = None
    header_indices = [i for i, line in enumerate(lines) if line.startswith("## ")]

    if not header_indices:
        # 没有二级标题，按一级标题或行数分块
        header_indices = [i for i, line in enumerate(lines) if line.startswith("# ")]
    if not header_indices:
        # 没有任何标题，按行数均分
        for start in range(0, total_lines, MAX_CHUNK_LINES):
            chunk_content = "\n".join(lines[start:start + MAX_CHUNK_LINES])
            chunks.append({
                "title": f"{filepath.stem} (部分 {len(chunks) + 1})",
                "content": chunk_content.strip(),
                "tags": path_tags + [stem_tag],
                "source": source,
            })
        return chunks

    # 按标题位置分块
    for i, idx in enumerate(header_indices):
        next_idx = header_indices[i + 1] if i + 1 < len(header_indices) else total_lines
        section_lines = lines[idx:next_idx]

        title_line = lines[idx]
        section_title = title_line.replace("## ", "").replace("# ", "").strip()

        # 单个章节太长？递归拆分
        if len(section_lines) > MAX_CHUNK_LINES:
            # 按三级标题再分
            sub_headers = [j for j, l in enumerate(section_lines) if l.startswith("### ")]
            if sub_headers:
                for si, sh in enumerate(sub_headers):
                    sn = sub_headers[si + 1] if si + 1 < len(sub_headers) else len(section_lines)
                    sub_content = "\n".join(section_lines[sh:sn])
                    sub_title_line = section_lines[sh]
                    sub_title = sub_title_line.replace("### ", "").strip()
                    full_title = f"{filepath.stem} > {section_title} > {sub_title}"
                    chunks.append({
                        "title": full_title,
                        "content": sub_content.strip(),
                        "tags": path_tags + [stem_tag],
                        "source": source,
                    })
            else:
                full_title = f"{filepath.stem} > {section_title} (部分)"
                chunks.append({
                    "title": full_title,
                    "content": "\n".join(section_lines).strip(),
                    "tags": path_tags + [stem_tag],
                    "source": source,
                })
        else:
            full_title = f"{filepath.stem} > {section_title}"
            chunks.append({
                "title": full_title,
                "content": "\n".join(section_lines).strip(),
                "tags": path_tags + [stem_tag],
                "source": source,
            })

    return chunks


def _infer_title(content: str, fallback: str) -> str:
    """从内容推断文档标题。"""
    lines = content.strip().split("\n")
    for line in lines[:20]:
        line = line.strip()
        if line.startswith("# "):
            return line.replace("# ", "").strip()
        if line.startswith("title:"):
            return line.replace("title:", "").strip().strip("\"'")
        if line.startswith("---"):
            # YAML front matter，跳过
            continue
    return fallback


# ── 本地去重缓存 ──────────────────────────────────────────

# 缓存文件名，存放在被吸入的目录根下
INGEST_CACHE_FILE = ".ingest_cache.json"


def _load_ingest_cache(root: Path) -> dict:
    """加载本地吸入缓存（文件级 SHA256 去重）。"""
    cache_path = root / INGEST_CACHE_FILE
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_ingest_cache(root: Path, cache: dict):
    """保存吸入缓存。"""
    cache_path = root / INGEST_CACHE_FILE
    # 限制缓存大小（最多保留 5000 条）
    if len(cache) > 5000:
        # 只保留最新的 4000 条
        sorted_keys = sorted(cache.keys(), key=lambda k: cache[k].get("ts", ""), reverse=True)
        cache = {k: cache[k] for k in sorted_keys[:4000]}
    try:
        cache_path.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass  # 写入失败不影响主流程


def _file_hash(filepath: Path) -> str:
    """计算文件 SHA256 哈希。"""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ── 吸入执行 ──────────────────────────────────────────────


def ingest_directory(root: Path, project_id: str = "", dry_run: bool = False,
                     verbose: bool = False) -> dict:
    """执行目录知识吸入。

    返回报告 dict:
      {files_scanned, chunks_total, chunks_new, chunks_skipped, chunks_failed, results: [...]}
    """
    report = {
        "files_scanned": 0,
        "files_skipped_cache": 0,
        "chunks_total": 0,
        "chunks_new": 0,
        "chunks_skipped": 0,
        "chunks_failed": 0,
        "results": [],
        "errors": [],
    }

    files = scan_files(root, verbose)
    report["files_scanned"] = len(files)

    # 加载去重缓存
    cache = _load_ingest_cache(root)
    # cache key: "{project_id}:{file_rel}"
    cache_prefix = f"{project_id}:" if project_id else ":"

    if verbose:
        _echo(f"\n📂 扫描到 {len(files)} 个文档文件")

    for filepath in files:
        rel = filepath.relative_to(root)
        rel_str = str(rel).replace("\\", "/")
        cache_key = f"{cache_prefix}{rel_str}"

        # 文件级去重检查
        if not dry_run:
            current_hash = _file_hash(filepath)
            cached_entry = cache.get(cache_key)
            if cached_entry and cached_entry.get("hash") == current_hash and cached_entry.get("status") == "ok":
                report["files_skipped_cache"] += 1
                if verbose:
                    _echo(f"  ⏭  文件未变更(缓存): {rel_str}")
                report["results"].append({
                    "file": str(filepath),
                    "action": "skipped (file unchanged)",
                })
                continue

        try:
            chunks = chunk_document(filepath)
        except Exception as e:
            report["errors"].append({"file": str(filepath), "error": str(e)})
            if verbose:
                _echo(f"  ❌ 分块失败: {filepath.name}: {e}")
            continue

        if verbose:
            _echo(f"\n  📄 {filepath.name} → {len(chunks)} 块")

        all_ok = True
        for chunk in chunks:
            report["chunks_total"] += 1
            body = {
                "title": chunk["title"],
                "content": chunk["content"],
                "source": "ingest-tool",
                "topics": chunk["tags"],
                "is_policy": False,
                "policy_name": "",
                "version": "1.0",
                "author": _PHYSICAL_USER,
                "project_id": project_id,
                "scope": "",
                "agent_id": "ingest-tool",
            }

            if dry_run:
                report["chunks_new"] += 1
                if verbose:
                    _echo(f"    📋 [DRY-RUN] 新增: {chunk['title'][:60]}")
                report["results"].append({
                    "file": str(filepath),
                    "title": chunk["title"],
                    "action": "new (dry-run)",
                })
                continue

            resp = _api_post("/v1/knowledge", body)

            if resp.get("status") == "ok":
                doc_id = resp.get("data", {}).get("doc_id")
                if doc_id:
                    # SHA256 去重：doc_id 是新生成的才算"新增"
                    report["chunks_new"] += 1
                    if verbose:
                        _echo(f"    ✅ 新增: {chunk['title'][:60]} → {doc_id[:12]}...")
                    report["results"].append({
                        "file": str(filepath),
                        "title": chunk["title"],
                        "doc_id": doc_id,
                        "action": "new",
                    })
                else:
                    report["chunks_skipped"] += 1
                    if verbose:
                        _echo(f"    ⏭  跳过(重复): {chunk['title'][:60]}")
                    report["results"].append({
                        "file": str(filepath),
                        "title": chunk["title"],
                        "action": "skipped (duplicate)",
                    })
            else:
                report["chunks_failed"] += 1
                err_msg = resp.get("error", {}).get("message", "未知错误")
                report["errors"].append({
                    "file": str(filepath),
                    "title": chunk["title"],
                    "error": err_msg,
                })
                if verbose:
                    _echo(f"    ❌ 失败: {chunk['title'][:60]}: {err_msg}")

        # 文件处理完毕 → 更新去重缓存
        if not dry_run and all_ok and chunks:
            cache[cache_key] = {
                "hash": current_hash,
                "status": "ok",
                "ts": datetime.now(timezone.utc).isoformat(),
            }
            _save_ingest_cache(root, cache)

    # 补充摘要
    parts = [f"扫描 {report['files_scanned']} 文件"]
    if report["files_skipped_cache"]:
        parts.append(f"（{report['files_skipped_cache']} 文件未变更跳过）")
    parts.append(f"，产生 {report['chunks_total']} 知识块，"
                 f"新增 {report['chunks_new']}，"
                 f"跳过 {report['chunks_skipped']}，"
                 f"失败 {report['chunks_failed']}")
    report["summary"] = "".join(parts)
    return report


# ── CLI ────────────────────────────────────────────────────


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="🧠 知识蒸馏吸入器 — 将本地文档吸入脑虫知识库",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--dir", "-d", required=True,
                        help="要扫描的文档目录路径")
    parser.add_argument("--project", "-p", default="",
                        help="项目隔离 ID，相同项目的知识可集中检索")
    parser.add_argument("--dry-run", action="store_true",
                        help="预览模式：扫描+分块但不写入知识库")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="显示详细处理日志")
    parser.add_argument("--url", default=_SERVER_URL,
                        help=f"脑虫服务地址（默认: {_SERVER_URL}）")
    parser.add_argument("--token", default="",
                        help="Bearer 鉴权令牌（默认从 CEREBRATE_SERVER_TOKEN 读取）")

    args = parser.parse_args(argv)

    # 覆盖全局配置
    if args.url:
        globals()["_SERVER_URL"] = args.url
    if args.token:
        globals()["_SERVER_TOKEN"] = args.token

    root = Path(args.dir).resolve()
    if not root.is_dir():
        _echo(f"错误: 目录不存在: {root}")
        sys.exit(1)

    _echo(f"🧠 知识蒸馏入脑虫")
    _echo(f"   目录:  {root}")
    _echo(f"   项目:  {args.project or '(全局)'}")
    _echo(f"   模式:  {'🔍 DRY-RUN（预览）' if args.dry_run else '📤 写入'}")
    _echo(f"   用户:  {_PHYSICAL_USER}")
    _echo("")

    report = ingest_directory(
        root=root,
        project_id=args.project,
        dry_run=args.dry_run,
        verbose=args.verbose or not args.dry_run,
    )

    _echo("")
    _echo("=" * 50)
    _echo("📊 吸入报告")
    _echo("=" * 50)
    _echo(f"  扫描文件:  {report['files_scanned']}")
    if report["files_skipped_cache"]:
        _echo(f"  缓存跳过:  {report['files_skipped_cache']}（文件未变更）")
    _echo(f"  知识块数:  {report['chunks_total']}")
    _echo(f"  新增入库:  {report['chunks_new']}")
    _echo(f"  跳过重复:  {report['chunks_skipped']}")
    _echo(f"  写入失败:  {report['chunks_failed']}")
    if report["errors"]:
        _echo(f"\n  错误详情:")
        for err in report["errors"][:5]:
            _echo(f"    ❌ [{err.get('file','?')}] {err.get('error','')}")
        if len(report["errors"]) > 5:
            _echo(f"    ... 还有 {len(report['errors']) - 5} 条错误")
    _echo(f"\n  {report['summary']}")

    # 以 JSON 格式输出完整报告（方便程序化调用）
    print("\n--- JSON REPORT ---")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

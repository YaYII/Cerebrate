#!/usr/bin/env python3
"""Cerebrate v5 — HTTP client CLI. Talks to a running Brain Server."""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path


def client_request(url: str, method: str, path: str, body: dict = None) -> dict:
    """Make an HTTP request to the Cerebrate Brain Server."""
    full_url = url.rstrip("/") + path
    data = None
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("CEREBRATE_SERVER_TOKEN", "")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        full_url, data=data, headers=headers, method=method)
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
        return {"status": "error", "error": {"code": 503, "message": f"无法连接服务器: {e.reason}"}}


def output(result: dict):
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") == "error":
        sys.exit(1)


def cmd_sense(args):
    output(client_request(args.url, "GET", "/v1/sense"))


def cmd_query(args):
    output(client_request(args.url, "POST", "/v1/query", {
        "query": args.query,
        "agent_id": args.agent_id or args.id or "cli",
        "user": args.user,
        "project_id": args.project,
        "scope": args.scope or None,
        "detail": bool(getattr(args, "detail", False)),
    }))


def cmd_search(args):
    """渐进式披露第 1 层：紧凑索引（不含全文，含 token 成本）"""
    output(client_request(args.url, "POST", "/v1/search", {
        "query": args.query,
        "agent_id": args.agent_id or args.id or "cli",
        "project_id": args.project,
        "scope": args.scope or None,
        "category": args.category or None,
        "limit": args.limit,
        "mode": getattr(args, "mode", "hybrid"),
    }))


def cmd_fulltext_rebuild(args):
    """全量重建 FTS5 全文索引"""
    output(client_request(args.url, "POST", "/v1/fulltext/rebuild", {}))


def cmd_project_context(args):
    """生成/读取项目级上下文（Phase 5 第 2 项）"""
    output(client_request(args.url, "POST", "/v1/project/context", {
        "project": args.project,
        "action": args.action,
        "limit": getattr(args, "limit", 50),
    }))

def cmd_project_profile(args):
    """业务画像（数据世界）：构建/读取项目领域树+依赖导航"""
    body = {
        "project": args.project,
        "action": args.action,
    }
    if args.action == "draft":
        body["llm_refine"] = args.llm_refine
        body["limit"] = args.limit
    output(client_request(args.url, "POST", "/v1/project/profile", body))

def cmd_project_navigate(args):
    """业务画像导航：定位目标域/实体，避免全量扫描代码"""
    output(client_request(args.url, "POST", "/v1/project/navigate", {
        "project": args.project,
        "target": args.target,
    }))

def cmd_project_harvest(args):
    """代码结构养料收割：扫描真实代码生成结构图谱（画像真实骨架）"""
    output(client_request(args.url, "POST", "/v1/project/harvest", {
        "project": args.project,
        "dir": args.dir,
        "exts": [args.exts] if args.exts else [".py"],
    }))

def cmd_code_sync(args):
    """代码同步：把本地完整项目代码打包上传到脑虫服务器（→代码仓→harvest）"""
    from cerebrate.tools.code_sync import build_package
    from pathlib import Path
    root = Path(args.dir).resolve()
    if not root.is_dir():
        print(json.dumps({"status": "error",
                          "error": {"code": 400,
                                    "message": f"目录不存在: {root}"}},
                         ensure_ascii=False))
        sys.exit(1)
    pkg = build_package(root, project_id=args.project,
                        incremental=not args.full,
                        branch=args.branch)
    mode = "增量" if pkg["incremental"] else "全量"
    print(f"打包完成[{mode}]: 变更 {pkg['files_changed']} / "
          f"删除 {pkg['files_deleted']} / 排除 {pkg['excluded_count']} 项 / "
          f"{pkg['total_bytes']/1024:.1f}KB",
          file=sys.stderr)
    for ex in pkg["excluded"][:10]:
        print(f"  ⛔ 排除 {ex['path']} ({ex['reason']})", file=sys.stderr)
    resp = client_request(args.url, "POST", "/v1/code/sync", {
        "project": args.project,
        "branch": pkg.get("branch", ""),
        "package_b64": pkg["package_b64"],
        "auto_harvest": True,
        "auto_profile": not args.no_profile,
        "delete_list": pkg.get("deleted", []),
    })
    output(resp)

def cmd_harvest_push(args):
    """结构 push（代码不离开本地）：本地 AST 分析 → 只把结构结果给脑虫"""
    from cerebrate.tools.code_harvest import harvest_project, _safe_branch
    from cerebrate.tools.code_sync import _git_branch
    from pathlib import Path
    root = Path(args.dir).resolve()
    if not root.is_dir():
        print(json.dumps({"status": "error",
                          "error": {"code": 400,
                                    "message": f"目录不存在: {root}"}},
                         ensure_ascii=False))
        sys.exit(1)
    branch = _safe_branch(args.branch or _git_branch(root))
    print(f"本地分析中: {root}（分支 {branch}，代码不离开本地）…",
          file=sys.stderr)
    harvest = harvest_project(root, project_id=args.project,
                              exts=tuple(args.exts.split(",")) if args.exts else None)
    print(f"  → 结构: {harvest['stats']['files']} 文件 / "
          f"{harvest['stats']['modules']} 模块 / "
          f"{harvest['stats']['endpoints']} 端点（已排除敏感文件）",
          file=sys.stderr)
    resp = client_request(args.url, "POST", "/v1/harvest/push", {
        "project": args.project,
        "branch": branch,
        "harvest": harvest,
        "auto_profile": True,
    })
    output(resp)

def cmd_project_work(args):
    """多人协作感知：工作声明/冲突检测"""
    output(client_request(args.url, "POST", "/v1/project/work", {
        "project": args.project,
        "action": args.action,
        "branch": args.branch,
        "module": args.module,
        "intent": args.intent,
        "agent_id": args.agent_id or "cli",
    }))


def cmd_timeline(args):
    """渐进式披露第 2 层：围绕 anchor 记忆的时序上下文"""
    output(client_request(args.url, "POST", "/v1/timeline", {
        "anchor": args.anchor or None,
        "query": args.query or None,
        "project_id": args.project,
        "scope": args.scope or None,
        "depth_before": args.before,
        "depth_after": args.after,
    }))


def cmd_propose(args):
    body = {
        "title": args.title,
        "content": args.content,
        "category": args.category,
        "tags": args.tags,
        "agent_id": args.agent_id or args.id or "cli",
        "problem": args.problem or "",
        "solution": args.solution or "",
        "project_id": args.project or "",
        "scope": args.scope or "",
        "validate": args.validate,
        "confidence": args.confidence,
    }
    output(client_request(args.url, "POST", "/v1/memories/propose", body))


def cmd_recall(args):
    output(client_request(args.url, "GET", "/v1/personal"))


def cmd_remember(args):
    output(client_request(args.url, "POST", "/v1/personal", {
        "user": args.user,
        "key": args.key,
        "value": args.value,
        "project_id": args.project or "",
    }))


def cmd_evolve(args):
    output(client_request(args.url, "POST", "/v1/evolve"))


def cmd_stats(args):
    output(client_request(args.url, "GET", "/v1/sense"))


def cmd_register(args):
    output(client_request(args.url, "POST", "/v1/agents/register", {
        "agent_id": args.agent_id or args.id,
        "agent_type": args.type,
        "capabilities": args.capabilities.split(",") if args.capabilities else [],
    }))


def cmd_events(args):
    output(client_request(args.url, "GET",
                          f"/v1/events?cursor={args.cursor}&limit={args.limit}"))


def cmd_doctrines(args):
    output(client_request(args.url, "GET", "/v1/doctrines"))


def cmd_vote(args):
    output(client_request(args.url, "POST", "/v1/consensus/vote", {
        "memory_id": args.memory_id,
        "agent": args.agent_id or args.id or "cli",
        "vote": args.vote,
        "evidence": args.evidence or "",
        "confidence": args.confidence,
    }))


def cmd_use_start(args):
    output(client_request(args.url, "POST", "/v1/usages/start", {
        "memory_id": args.memory_id,
        "agent": args.agent_id or args.id or "cli",
        "problem": args.problem,
        "project_id": args.project or "",
    }))


def cmd_use_finish(args):
    output(client_request(args.url, "POST", "/v1/usages/finish", {
        "usage_id": args.usage_id,
        "outcome": args.outcome,
        "feedback": args.feedback or "",
    }))


def cmd_llm_status(args):
    output(client_request(args.url, "GET", "/v1/llm/status"))


def cmd_brain_assess(args):
    output(client_request(args.url, "GET", "/v1/brain/assess"))


def cmd_consensus(args):
    output(client_request(args.url, "GET", f"/v1/consensus/{args.memory_id}"))


def cmd_memory_get(args):
    output(client_request(args.url, "GET", f"/v1/memories/{args.memory_id}"))


def cmd_ingest(args):
    """知识蒸馏吸入：将本地文档批量吸入脑虫知识库。"""
    from cerebrate.tools.ingest import ingest_directory
    import cerebrate.tools.ingest as _ingest_mod
    # 传递远程 URL 和 Token，使 ingest_directory 内部 _api_post 发到正确地址
    _ingest_mod._SERVER_URL = args.url
    if hasattr(args, 'token') and args.token:
        _ingest_mod._SERVER_TOKEN = args.token
    root = Path(args.dir).resolve()
    if not root.is_dir():
        print(json.dumps({"status": "error",
                          "error": {"code": 400, "message": f"目录不存在: {root}"}},
                         ensure_ascii=False))
        sys.exit(1)
    report = ingest_directory(
        root=root,
        project_id=args.project or "",
        dry_run=args.dry_run,
        verbose=args.verbose,
    )
    print(json.dumps({"status": "ok", "data": report,
                      "meta": {"protocol": "v5"}},
                     ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Cerebrate v5 — HTTP Client CLI")
    parser.add_argument("--url", default="http://127.0.0.1:8765",
                        help="Brain Server URL (default: http://127.0.0.1:8765)")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("sense", help="感知虫群状态")
    p.add_argument("--id", default="cli", help="Agent ID")
    p.set_defaults(func=cmd_sense)

    p = sub.add_parser("query", help="搜索虫群记忆")
    p.add_argument("query", help="搜索查询")
    p.add_argument("--id", default="cli", help="Agent ID")
    p.add_argument("--agent-id", default="")
    p.add_argument("--user", default="")
    p.add_argument("--project", default="")
    p.add_argument("--detail", action="store_true",
                   help="返回完整内容（默认渐进式披露只返回索引）")
    p.add_argument("--scope", default="",
                   choices=["", "general", "project", "all"],
                   help="记忆分类: general=只查通用记忆; project=项目记忆+通用记忆; "
                        "all=跨项目全量（默认按 project_id 推断）")
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("search", help="搜索记忆索引（渐进式披露第1层，紧凑/低成本）")
    p.add_argument("query", help="搜索查询")
    p.add_argument("--id", default="cli", help="Agent ID")
    p.add_argument("--agent-id", default="")
    p.add_argument("--project", default="")
    p.add_argument("--category", default="")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--mode", default="hybrid",
                   choices=["hybrid", "fts", "vector"],
                   help="检索模式: hybrid=FTS+向量混合(默认); fts=仅全文精确关键词; "
                        "vector=仅向量语义")
    p.add_argument("--scope", default="",
                   choices=["", "general", "project", "all"],
                   help="记忆分类: general=只查通用记忆; project=项目记忆+通用记忆")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("fulltext", help="FTS5 全文索引管理")
    fts_sub = p.add_subparsers(dest="fulltext_command")
    pr = fts_sub.add_parser("rebuild", help="从 DocStore 全量重建全文索引")
    pr.set_defaults(func=cmd_fulltext_rebuild)

    p = sub.add_parser("project-context",
                       help="项目级上下文（生成/读取浓缩记忆概览文件）")
    p.add_argument("--project", default="", help="项目 ID")
    p.add_argument("--action", default="build",
                   choices=["build", "read", "list"],
                   help="build=生成/更新(默认); read=读取; list=列出已有项目")
    p.add_argument("--limit", type=int, default=50,
                   help="build 时收录的记忆条数上限（默认 50，最大 200）")
    p.set_defaults(func=cmd_project_context)

    p = sub.add_parser("project-profile",
                       help="业务画像（数据世界）：项目的领域树+实体关系+依赖导航")
    p.add_argument("--project", default="", help="项目 ID")
    p.add_argument("--action", default="read",
                   choices=["read", "list", "draft", "save", "attach"],
                   help="read=读取(默认); list=列出; draft=构建草稿; "
                        "save=保存确认版; attach=挂载记忆")
    p.add_argument("--llm-refine", action="store_true",
                   help="draft 时用 LLM 精炼画像（默认关）")
    p.add_argument("--limit", type=int, default=200,
                   help="draft 时收录的业务记忆条数上限（默认 200，最大 500）")
    p.set_defaults(func=cmd_project_profile)

    p = sub.add_parser("project-navigate",
                       help="业务画像导航：定位目标域/实体（避免大面积扫描代码）")
    p.add_argument("--project", default="", help="项目 ID")
    p.add_argument("--target", default="", help="目标业务关键词")
    p.set_defaults(func=cmd_project_navigate)

    p = sub.add_parser("project-harvest",
                       help="代码结构养料收割（真实代码 AST → 画像骨架）")
    p.add_argument("--project", default="", help="项目 ID")
    p.add_argument("--dir", default="", help="项目代码根目录（留空则读取已生成）")
    p.add_argument("--exts", default=".py", help="扫描扩展名（默认 .py）")
    p.set_defaults(func=cmd_project_harvest)

    p = sub.add_parser("code-sync",
                       help="代码同步：本地完整项目代码打包上传到脑虫（→代码仓→harvest→画像）")
    p.add_argument("--project", default="", help="项目 ID")
    p.add_argument("--dir", default="", help="本地项目代码根目录")
    p.add_argument("--full", action="store_true",
                   help="强制全量同步（默认增量，只传变更文件）")
    p.add_argument("--no-profile", action="store_true",
                   help="同步后不自动生成画像草稿")
    p.add_argument("--branch", default="",
                   help="git 分支（默认自动从 git 推断当前分支）")
    p.set_defaults(func=cmd_code_sync)

    p = sub.add_parser("harvest-push",
                       help="结构 push：本地分析代码→只把结构给脑虫（代码不离开本地，推荐）")
    p.add_argument("--project", default="", help="项目 ID")
    p.add_argument("--dir", default="", help="本地项目代码根目录")
    p.add_argument("--branch", default="",
                   help="git 分支（默认自动从 git 推断当前分支）")
    p.add_argument("--exts", default=".py",
                   help="扫描扩展名，逗号分隔（默认 .py；PHP 用 .php，Java 用 .java）")
    p.set_defaults(func=cmd_harvest_push)

    p = sub.add_parser("project-work",
                       help="多人协作感知：声明/释放/列出工作（谁在处理哪个功能）")
    p.add_argument("--project", default="", help="项目 ID")
    p.add_argument("--action", default="list",
                   choices=["claim", "release", "list"],
                   help="claim=声明; release=释放; list=列出(默认)")
    p.add_argument("--branch", default="", help="git 分支（claim 时用）")
    p.add_argument("--module", default="", help="功能/模块/实体")
    p.add_argument("--intent", default="", help="处理意图")
    p.add_argument("--agent-id", default="", help="AI/开发者标识")
    p.set_defaults(func=cmd_project_work)

    p = sub.add_parser("timeline", help="查看记忆时间线（渐进式披露第2层，时序上下文）")
    p.add_argument("--anchor", default="", help="anchor 记忆 ID（不传则用 query 找 top1）")
    p.add_argument("--query", default="", help="查询词（anchor 缺省时用 top1）")
    p.add_argument("--id", default="cli", help="Agent ID")
    p.add_argument("--project", default="")
    p.add_argument("--scope", default="",
                   choices=["", "general", "project", "all"])
    p.add_argument("--before", type=int, default=3, help="anchor 前取几条事件")
    p.add_argument("--after", type=int, default=3, help="anchor 后取几条事件")
    p.set_defaults(func=cmd_timeline)

    p = sub.add_parser("propose", help="提交新记忆")
    p.add_argument("--title", required=True)
    p.add_argument("--content", required=True)
    p.add_argument("--category", default="coding")
    p.add_argument("--tags", default="")
    p.add_argument("--id", default="cli")
    p.add_argument("--agent-id", default="")
    p.add_argument("--problem", default="")
    p.add_argument("--solution", default="")
    p.add_argument("--project", default="")
    p.add_argument("--scope", default="",
                   choices=["", "general", "project"],
                   help="记忆分类: general=通用记忆; project=项目记忆（默认按 project_id 推断）")
    p.add_argument("--validate", action="store_true", default=False)
    p.add_argument("--confidence", type=float, default=1.0)
    p.set_defaults(func=cmd_propose)

    p = sub.add_parser("recall", help="读取用户偏好")
    p.add_argument("--user", default="default")
    p.set_defaults(func=cmd_recall)

    p = sub.add_parser("remember", help="记住用户偏好")
    p.add_argument("--user", required=True)
    p.add_argument("--key", required=True)
    p.add_argument("--value", required=True)
    p.add_argument("--project", default="")
    p.set_defaults(func=cmd_remember)

    p = sub.add_parser("evolve", help="触发脑进化")
    p.set_defaults(func=cmd_evolve)

    p = sub.add_parser("stats", help="查看虫群统计")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("register", help="注册代理")
    p.add_argument("--id", default="cli")
    p.add_argument("--agent-id", default="")
    p.add_argument("--type", default="cli")
    p.add_argument("--capabilities", default="")
    p.set_defaults(func=cmd_register)

    p = sub.add_parser("events", help="读取事件日志")
    p.add_argument("--cursor", type=int, default=0)
    p.add_argument("--limit", type=int, default=100)
    p.set_defaults(func=cmd_events)

    p = sub.add_parser("doctrines", help="读取权威教条")
    p.set_defaults(func=cmd_doctrines)

    p = sub.add_parser("vote", help="共识投票")
    p.add_argument("--memory-id", required=True)
    p.add_argument("--vote", required=True,
                   choices=["support", "oppose", "abstain"])
    p.add_argument("--id", default="cli")
    p.add_argument("--agent-id", default="")
    p.add_argument("--evidence", default="")
    p.add_argument("--confidence", type=float, default=1.0)
    p.set_defaults(func=cmd_vote)

    # use start / use finish
    p = sub.add_parser("use", help="记忆复用追踪")
    use_sub = p.add_subparsers(dest="use_command")
    ps = use_sub.add_parser("start", help="开始追踪记忆复用")
    ps.add_argument("--memory-id", required=True)
    ps.add_argument("--id", default="cli")
    ps.add_argument("--agent-id", default="")
    ps.add_argument("--problem", required=True)
    ps.add_argument("--project", default="")
    ps.set_defaults(func=cmd_use_start)
    pf = use_sub.add_parser("finish", help="完成记忆复用追踪")
    pf.add_argument("--usage-id", required=True)
    pf.add_argument("--outcome", required=True,
                    choices=["success", "partial", "failure"])
    pf.add_argument("--feedback", default="")
    pf.set_defaults(func=cmd_use_finish)

    p = sub.add_parser("llm", help="LLM 状态查询")
    llm_sub = p.add_subparsers(dest="llm_command")
    pl = llm_sub.add_parser("status", help="查看 LLM 状态")
    pl.set_defaults(func=cmd_llm_status)

    p = sub.add_parser("brain", help="脑虫评估")
    brain_sub = p.add_subparsers(dest="brain_command")
    pb = brain_sub.add_parser("assess", help="元认知评估")
    pb.set_defaults(func=cmd_brain_assess)

    p = sub.add_parser("consensus", help="读取共识快照")
    p.add_argument("--memory-id", required=True)
    p.set_defaults(func=cmd_consensus)

    p = sub.add_parser("memory-get", help="读取指定记忆")
    p.add_argument("--memory-id", required=True)
    p.set_defaults(func=cmd_memory_get)

    p = sub.add_parser("ingest", help="📥 知识蒸馏吸入：将本地文档批量吸入脑虫知识库")
    p.add_argument("--dir", "-d", required=True, help="文档目录路径")
    p.add_argument("--project", "-p", default="", help="项目 ID（用于隔离）")
    p.add_argument("--dry-run", action="store_true", help="预览模式，不写入")
    p.add_argument("--verbose", "-v", action="store_true", help="显示详细日志")
    p.set_defaults(func=cmd_ingest)

    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        sys.exit(1)
    args.func(args)


if __name__ == "__main__":
    main()

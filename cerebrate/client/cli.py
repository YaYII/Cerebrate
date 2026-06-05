#!/usr/bin/env python3
"""Cerebrate v5 — HTTP client CLI. Talks to a running Brain Server."""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error


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
    p.set_defaults(func=cmd_query)

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

    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        sys.exit(1)
    args.func(args)


if __name__ == "__main__":
    main()

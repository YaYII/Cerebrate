#!/usr/bin/env python3
"""Cerebrate v5 CLI.

This CLI is no longer an authority over group memory. It has two roles:
1. start the authoritative Brain Server;
2. act as a thin client that sends requests to that server.
"""

import argparse
import json
import sys

from cerebrate.config import config
from cerebrate.protocol import err


class CerebrateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        _out(err(message, code=400, protocol="v5"))


def _out(payload: dict):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0 if payload.get("status") == "ok" else 1)


def _client(args):
    from cerebrate.client import BrainClient
    return BrainClient(args.url, timeout=args.timeout)


def cmd_serve(args):
    from cerebrate.server import serve
    serve(args.host, args.port, quiet=args.quiet)


def cmd_register(args):
    capabilities = [c.strip() for c in args.capabilities.split(",") if c.strip()]
    _out(_client(args).post("/v1/agents/register", {
        "agent_id": args.id,
        "agent_type": args.type,
        "capabilities": capabilities,
        "metadata": {"client": "cerebrate-cli"},
    }))


def cmd_sense(args):
    _out(_client(args).get("/v1/sense"))


def cmd_query(args):
    _out(_client(args).post("/v1/query", {
        "query": args.query,
        "user": args.user,
        "agent_id": args.agent,
        "project_id": args.project,
    }))


def cmd_propose(args):
    tags = [t.strip() for t in args.tags.split(",") if t.strip()]
    _out(_client(args).post("/v1/memories/propose", {
        "title": args.title,
        "content": args.content,
        "category": args.category,
        "tags": tags,
        "agent_id": args.agent,
        "problem": args.problem,
        "solution": args.solution,
        "project_id": args.project,
        "life_stage": args.life_stage,
        "confidence": args.confidence,
        "evidence": args.evidence,
        "validate": not args.no_validate,
    }))


def cmd_use_start(args):
    _out(_client(args).post("/v1/usages/start", {
        "memory_id": args.memory_id,
        "agent_id": args.agent,
        "problem": args.problem,
        "project_id": args.project,
    }))


def cmd_use_finish(args):
    _out(_client(args).post("/v1/usages/finish", {
        "usage_id": args.usage_id,
        "outcome": args.outcome,
        "feedback": args.feedback,
    }))


def cmd_vote(args):
    _out(_client(args).post("/v1/consensus/vote", {
        "memory_id": args.memory_id,
        "agent_id": args.agent,
        "vote": args.vote,
        "evidence": args.evidence,
        "confidence": args.confidence,
        "project_id": args.project,
    }))


def cmd_events(args):
    _out(_client(args).get("/v1/events", {"cursor": args.cursor, "limit": args.limit}))


def cmd_doctrines(args):
    _out(_client(args).get("/v1/doctrines"))


def cmd_memory_get(args):
    _out(_client(args).get(f"/v1/memories/{args.memory_id}"))


def cmd_evolve(args):
    _out(_client(args).post("/v1/evolve", {}))


def cmd_migrate(args):
    from cerebrate.migrate import migrate_all, export_seeds, reindex_from_seeds
    if args.export_seeds:
        _out({"status": "ok", "data": export_seeds(), "meta": {"protocol": "v5"}})
    elif args.reindex:
        _out({"status": "ok", "data": reindex_from_seeds(args.dry_run), "meta": {"protocol": "v5"}})
    elif args.swarm_only:
        result = {"swarm": _migrate_swarm(args.dry_run)}
        _out({"status": "ok", "data": result, "meta": {"protocol": "v5"}})
    else:
        result = migrate_all(args.dry_run)
        _out({"status": "ok", "data": result, "meta": {"protocol": "v5"}})


def _migrate_swarm(dry_run: bool) -> int:
    from cerebrate.migrate import migrate_swarm
    return migrate_swarm(dry_run)


def _add_client_common(parser):
    parser.add_argument("--url", default=config.server_url or "http://127.0.0.1:8765")
    parser.add_argument("--timeout", type=float, default=30.0)


def main():
    parser = CerebrateArgumentParser(description="Cerebrate v5 - Brain Server client")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("serve", help="start authoritative Brain Server")
    p.add_argument("--host", default=config.server_host)
    p.add_argument("--port", type=int, default=config.server_port)
    p.add_argument("--quiet", "-q", action="store_true")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("register", help="register an AI unit with the Brain Server")
    p.add_argument("--id", required=True)
    p.add_argument("--type", default="cli")
    p.add_argument("--capabilities", default="")
    _add_client_common(p)
    p.set_defaults(func=cmd_register)

    p = sub.add_parser("sense", help="query authoritative brain state")
    _add_client_common(p)
    p.set_defaults(func=cmd_sense)

    p = sub.add_parser("query", help="query group memory through Brain Server")
    p.add_argument("query")
    p.add_argument("--user", "-u", default="default")
    p.add_argument("--agent", "-a", default="cli-client")
    p.add_argument("--project", "-p", default="")
    _add_client_common(p)
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("propose", help="submit a candidate memory; server decides lifecycle")
    p.add_argument("--title", required=True)
    p.add_argument("--content", required=True)
    p.add_argument("--category", default="general")
    p.add_argument("--tags", default="")
    p.add_argument("--agent", "-a", default="cli-client")
    p.add_argument("--problem", default="")
    p.add_argument("--solution", default="")
    p.add_argument("--project", "-p", default="")
    p.add_argument("--life-stage", default="memory", choices=["nutrient", "memory"])
    p.add_argument("--confidence", type=float, default=1.0)
    p.add_argument("--evidence", default="")
    p.add_argument("--no-validate", action="store_true")
    _add_client_common(p)
    p.set_defaults(func=cmd_propose)

    p_use = sub.add_parser("use", help="report memory reuse")
    use_sub = p_use.add_subparsers(dest="use_cmd")
    p = use_sub.add_parser("start")
    p.add_argument("--memory-id", required=True)
    p.add_argument("--agent", "-a", required=True)
    p.add_argument("--problem", required=True)
    p.add_argument("--project", "-p", default="")
    _add_client_common(p)
    p.set_defaults(func=cmd_use_start)
    p = use_sub.add_parser("finish")
    p.add_argument("--usage-id", required=True)
    p.add_argument("--outcome", required=True, choices=["success", "partial", "failure"])
    p.add_argument("--feedback", default="")
    _add_client_common(p)
    p.set_defaults(func=cmd_use_finish)

    p = sub.add_parser("vote", help="submit a consensus vote event")
    p.add_argument("--memory-id", required=True)
    p.add_argument("--agent", "-a", required=True)
    p.add_argument("--vote", required=True, choices=["support", "oppose", "abstain"])
    p.add_argument("--evidence", default="")
    p.add_argument("--confidence", type=float, default=1.0)
    p.add_argument("--project", "-p", default="")
    _add_client_common(p)
    p.set_defaults(func=cmd_vote)

    p = sub.add_parser("events", help="read durable server events")
    p.add_argument("--cursor", type=int, default=0)
    p.add_argument("--limit", type=int, default=100)
    _add_client_common(p)
    p.set_defaults(func=cmd_events)

    p = sub.add_parser("doctrines", help="read authoritative doctrines")
    _add_client_common(p)
    p.set_defaults(func=cmd_doctrines)

    p_memory = sub.add_parser("memory", help="read memories")
    memory_sub = p_memory.add_subparsers(dest="memory_cmd")
    p = memory_sub.add_parser("get")
    p.add_argument("--memory-id", required=True)
    _add_client_common(p)
    p.set_defaults(func=cmd_memory_get)

    p = sub.add_parser("evolve", help="ask Brain Server to run evolution")
    _add_client_common(p)
    p.set_defaults(func=cmd_evolve)

    p = sub.add_parser("migrate", help="migrate JSON memories to ChromaDB / export seeds / reindex")
    p.add_argument("--dry-run", action="store_true", help="preview without executing")
    p.add_argument("--swarm-only", action="store_true", help="only migrate swarm memories")
    p.add_argument("--export-seeds", action="store_true", help="export ChromaDB memories to JSONL seed files")
    p.add_argument("--reindex", action="store_true", help="rebuild ChromaDB index from seed files")
    p.set_defaults(func=cmd_migrate)

    args = parser.parse_args()
    if not hasattr(args, "func"):
        _out(err("missing command", code=400, protocol="v5"))
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as e:
        _out(err(str(e), code=500, protocol="v5", exception=e.__class__.__name__))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Cerebrate v5 server CLI.

This module belongs to the authoritative Brain Server project. Commands here
may start the server or perform local server maintenance.
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


def cmd_serve(args):
    from cerebrate.server.http import serve
    serve(args.host, args.port, quiet=args.quiet)


def cmd_migrate(args):
    from cerebrate.migrate import migrate_all, export_seeds, reindex_from_seeds
    if args.export_seeds:
        result = export_seeds()
    elif args.reindex:
        result = reindex_from_seeds(args.dry_run)
    elif args.swarm_only:
        result = {"swarm": _migrate_swarm(args.dry_run)}
    else:
        result = migrate_all(args.dry_run)
    _out({"status": "ok", "data": result, "meta": {"protocol": "v5"}})


def _migrate_swarm(dry_run: bool) -> int:
    from cerebrate.migrate import migrate_swarm
    return migrate_swarm(dry_run)


def main(argv=None):
    parser = CerebrateArgumentParser(description="Cerebrate v5 - Brain Server")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("serve", help="start authoritative Brain Server")
    p.add_argument("--host", default=config.server_host)
    p.add_argument("--port", type=int, default=config.server_port)
    p.add_argument("--quiet", "-q", action="store_true")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("migrate", help="server maintenance: migrate/export/reindex memory")
    p.add_argument("--dry-run", action="store_true", help="preview without executing")
    p.add_argument("--swarm-only", action="store_true", help="only migrate swarm memories")
    p.add_argument("--export-seeds", action="store_true", help="export ChromaDB memories to JSONL seed files")
    p.add_argument("--reindex", action="store_true", help="rebuild ChromaDB index from seed files")
    p.set_defaults(func=cmd_migrate)

    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        _out(err("missing server command", code=400, protocol="v5"))
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as e:
        _out(err(str(e), code=500, protocol="v5", exception=e.__class__.__name__))


if __name__ == "__main__":
    main()

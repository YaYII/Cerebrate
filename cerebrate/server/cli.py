#!/usr/bin/env python3
"""
Cerebrate v5 server CLI.

This module belongs to the authoritative Brain Server project. Commands here
may start the server or perform local server maintenance.
"""

import argparse
import json
import sys

from cerebrate.config import config
from cerebrate.protocol import err


class CerebrateArgumentParser(argparse.ArgumentParser):
    """服务端参数解析器：解析失败时输出协议 JSON 错误而非打印 usage。."""

    def error(self, message):
        """参数错误处理：输出错误响应 JSON（code=400）并以退出码 1 结束。."""
        _out(err(message, code=400, protocol="v5"))


def _out(payload: dict):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0 if payload.get("status") == "ok" else 1)


def cmd_serve(args):
    """启动权威脑虫服务端（serve）。."""
    from cerebrate.server.http import serve
    serve(args.host, args.port, quiet=args.quiet)


def cmd_migrate(args):
    """迁移命令分发：导出种子 / 重索引 / 指定集合迁移。."""
    from cerebrate.migrate import export_seeds, migrate_all, reindex_from_seeds
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
    """服务端 CLI 入口：定义 serve/migrate 子命令并分发。."""
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

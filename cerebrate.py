#!/usr/bin/env python3
"""Cerebrate v5 — Brain Server entrypoint.

Use clients/node/ for client commands (sense, query, propose, etc.).
"""

if __name__ == "__main__":
    from server.cli import main as server_main
    server_main()

#!/usr/bin/env python3
"""Cerebrate v5 — Unified entrypoint.

Commands are routed based on context:
  serve / migrate → Brain Server (cerebrate.server.cli)
  everything else → Client CLI (cerebrate.client.cli)
"""

import sys

SERVER_COMMANDS = {"serve", "migrate"}

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in SERVER_COMMANDS:
        from cerebrate.server.cli import main as server_main
        server_main()
    else:
        from cerebrate.client.cli import main as client_main
        client_main()

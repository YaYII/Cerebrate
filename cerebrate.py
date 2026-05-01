#!/usr/bin/env python3
"""Cerebrate v5 repository entrypoint.

The real projects live at top level:
- server/ is the authoritative Brain Server.
- client/ is the HTTP-only battle-unit client.
"""

import sys


SERVER_COMMANDS = {"serve", "migrate"}


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command in SERVER_COMMANDS:
        from server.cli import main as server_main
        server_main()
        return
    from client.cli import main as client_main
    client_main()


if __name__ == "__main__":
    main()

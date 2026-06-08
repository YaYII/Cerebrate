#!/usr/bin/env python3
"""Cerebrate v5 — Unified entrypoint.

Commands are routed based on context:
  serve / migrate → Brain Server (cerebrate.server.cli)
  everything else → Client CLI (cerebrate.client.cli)
"""

import os
import sys

SERVER_COMMANDS = {"serve", "migrate"}


def _must_run_in_docker():
    """强制服务端命令只能在 Docker 容器中运行。

    流程:
      1. 已在 Docker 容器内 (/.dockerenv) → 放行
      2. 本地执行:
         a. Docker 容器已运行 → 提示并退出
         b. Docker 未运行 → 自动启动容器，提示通过客户端连接
    """
    if os.environ.get("CEREBRATE_DOCKER_SKIP_CHECK") == "1":
        return
    # 已在 Docker 容器内 → 放行
    if os.path.exists("/.dockerenv"):
        return

    # ── 本地执行检查逻辑 ──
    import subprocess
    project_root = os.path.dirname(os.path.abspath(__file__))

    def _docker_ps():
        try:
            result = subprocess.run(
                ["docker", "ps", "--filter", "name=cerebrate",
                 "--filter", "status=running", "--format", "{{.Names}}"],
                capture_output=True, text=True, timeout=10,
            )
            return "cerebrate" in result.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    if _docker_ps():
        # Docker 容器已在运行
        print(
            "╔══════════════════════════════════════════════════════╗",
            file=sys.stderr,
        )
        print(
            "║  ⚠️  脑虫 Docker 容器已在运行                        ║",
            file=sys.stderr,
        )
        print(
            "║  不能重复本地启动，请通过客户端连接:                   ║",
            file=sys.stderr,
        )
        print(
            "║    reasonix chat -c                                 ║",
            file=sys.stderr,
        )
        print(
            "║    python3 cerebrate.py sense                       ║",
            file=sys.stderr,
        )
        print(
            "║                                                    ║",
            file=sys.stderr,
        )
        print(
            "║  如需重启容器: docker compose restart                ║",
            file=sys.stderr,
        )
        print(
            "╚══════════════════════════════════════════════════════╝",
            file=sys.stderr,
        )
        sys.exit(1)

    # Docker 未运行 → 自动启动
    print(
        "╔══════════════════════════════════════════════════════╗",
        file=sys.stderr,
    )
    print(
        "║  🚀 正在自动启动脑虫 Docker 容器...                    ║",
        file=sys.stderr,
    )
    print(
        "╚══════════════════════════════════════════════════════╝",
        file=sys.stderr,
    )
    try:
        subprocess.run(
            ["docker", "compose", "up", "-d", "--build"],
            cwd=project_root,
            check=True,
            timeout=120,
        )
    except subprocess.CalledProcessError:
        print("错误: Docker 启动失败，请手动执行:", file=sys.stderr)
        print(
            f"  cd {project_root} && docker compose up -d --build", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("错误: 未找到 docker 命令，请先安装 Docker", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("错误: Docker 启动超时 (120s)", file=sys.stderr)
        sys.exit(1)

    print(
        "╔══════════════════════════════════════════════════════╗",
        file=sys.stderr,
    )
    print(
        "║  ✅ 脑虫 Docker 容器已启动                            ║",
        file=sys.stderr,
    )
    print(
        "║  请通过客户端连接，不要本地直接运行:                    ║",
        file=sys.stderr,
    )
    print(
        "║    reasonix chat -c                                 ║",
        file=sys.stderr,
    )
    print(
        "║    python3 cerebrate.py sense                       ║",
        file=sys.stderr,
    )
    print(
        "╚══════════════════════════════════════════════════════╝",
        file=sys.stderr,
    )
    sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in SERVER_COMMANDS:
        _must_run_in_docker()
        from cerebrate.server.cli import main as server_main
        server_main()
    else:
        from cerebrate.client.cli import main as client_main
        client_main()

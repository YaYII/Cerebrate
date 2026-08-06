#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Cerebrate MCP 一键安装（Node 优先，零依赖）
#
# 用法:
#   bash -c "$(curl -fsSL <脑虫地址>/mcp/install.sh)" -- \
#     --url <脑虫地址> --token <你的user token>
#   bash install-mcp.sh --url https://.../cerebrate --token xxx
#
# 说明:
#   - 首选 Node.js 运行（nodejs 一定有，零依赖，无需装 Python）
#   - 从脑虫公网域名下载 mcp.js（不经 GitHub）
#   - 生成 ~/.cerebrate-mcp/cerebrate.env（URL + token，chmod 600）
#   - 打印各客户端（Codex/Claude Code/Qoder/opencode）配置片段
#   - 无 node 时回退 Python 模式（clone 仓库）；Docker 见末尾说明
#   - 直接本机安装（MCP 需要本地实体化 + 用户代码库分析，不推荐容器化）
# ─────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="${CEREBRATE_MCP_INSTALL_DIR:-$HOME/.cerebrate-mcp}"
REPO_URL="${CEREBRATE_MCP_REPO:-https://github.com/YaYII/Cerebrate.git}"
SERVER_URL=""
TOKEN=""
WRITE_ENV=1

usage() {
    cat <<EOF
用法: bash install-mcp.sh [--url <脑虫地址>] [--token <user token>] [--dir <安装目录>] [--no-env]

  --url    脑虫服务地址（从管理员获取，如 https://xxx.ngrok-free.dev/cerebrate）
  --token  你的 user token（管理员开通后提供；唯一凭证，长期有效）
  --dir    安装目录（默认 ~/.cerebrate-mcp）
  --no-env 不生成 cerebrate.env（仅安装代码）

示例:
  bash -c "\$(curl -fsSL https://xxx.ngrok-free.dev/cerebrate/mcp/install.sh)" -- \
    --url https://xxx.ngrok-free.dev/cerebrate --token f3ea02df761548e5808454c5aa2c231a
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --url) SERVER_URL="${2:-}"; shift 2 ;;
        --token) TOKEN="${2:-}"; shift 2 ;;
        --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
        --no-env) WRITE_ENV=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数: $1"; usage; exit 1 ;;
    esac
done

color() { printf "\033[1;%sm%s\033[0m\n" "$1" "$2"; }
ok()   { color 32 "[✓] $1"; }
info() { color 36 "[•] $1"; }
warn() { color 33 "[!] $1"; }
err()  { color 31 "[✗] $1"; }

mkdir -p "$INSTALL_DIR"

# ── 1. 选择运行方式：Node 优先，Python 备选 ──
MODE=""
if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node --version)
    ok "检测到 Node.js ${NODE_VER}（首选，零依赖）"
    MODE="node"
elif command -v python3 >/dev/null 2>&1; then
    if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)' 2>/dev/null; then
        ok "未检测到 node，回退 Python 模式（需 Python 3.8+）"
        MODE="python"
    else
        err "未检测到 node，且 Python < 3.8。请安装 Node.js（https://nodejs.org）或 Python 3.8+"
        exit 1
    fi
else
    err "未检测到 node 或 python3。请先安装 Node.js（https://nodejs.org）"
    exit 1
fi

# ── 2. 获取代码 ──
if [[ "$MODE" == "node" ]]; then
    if [[ -z "$SERVER_URL" ]]; then
        err "Node 模式需要 --url 才能从脑虫服务下载 mcp.js"
        usage; exit 1
    fi
    MCP_URL="$SERVER_URL/mcp/mcp.js"
    info "从公网下载 mcp.js: $MCP_URL"
    if ! curl -fsSL "$MCP_URL" -o "$INSTALL_DIR/mcp.js"; then
        err "下载失败。请检查 --url 是否正确、脑虫服务是否可达"
        exit 1
    fi
    if ! node --check "$INSTALL_DIR/mcp.js" 2>/dev/null; then
        err "下载的 mcp.js 校验失败（文件可能不完整）"
        exit 1
    fi
    ok "mcp.js 已下载并校验通过"
else
    if command -v git >/dev/null 2>&1; then
        info "克隆 Cerebrate 仓库到 $INSTALL_DIR ..."
        if [[ -d "$INSTALL_DIR/.git" ]]; then
            (cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null || true)
        else
            git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
        fi
    else
        warn "未找到 git，改用下载压缩包..."
        TARBALL="$INSTALL_DIR/cerebrate.tar.gz"
        curl -fsSL "https://github.com/YaYII/Cerebrate/archive/refs/heads/master.tar.gz" -o "$TARBALL"
        tar -xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1
        rm -f "$TARBALL"
    fi
    if [[ ! -f "$INSTALL_DIR/cerebrate/mcp.py" ]]; then
        err "Python 模式安装失败（缺少 cerebrate/mcp.py）"
        exit 1
    fi
    ok "Python 模式代码就绪"
fi

# ── 3. 生成本地配置 env（URL + token）──
ENV_FILE="$INSTALL_DIR/cerebrate.env"
if [[ "$WRITE_ENV" == "1" ]]; then
    if [[ -n "$SERVER_URL" || -n "$TOKEN" ]]; then
        umask 077
        {
            [[ -n "$SERVER_URL" ]] && echo "CEREBRATE_SERVER_URL=$SERVER_URL"
            [[ -n "$TOKEN" ]] && echo "CEREBRATE_SERVER_TOKEN=$TOKEN"
        } > "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        ok "配置已写入 $ENV_FILE（chmod 600，仅本用户可读）"
    else
        warn "未提供 --url/--token，跳过 env 生成（之后可手动编辑 $ENV_FILE）"
    fi
fi

# ── 4. 自检 ──
info "自检..."
if [[ "$MODE" == "node" ]]; then
    (cd "$INSTALL_DIR" && node mcp.js status) || warn "自检未完全通过（若未配 URL/token 属正常）"
else
    (cd "$INSTALL_DIR" && python3 -m cerebrate.mcp status) || warn "自检未完全通过（若未配 URL/token 属正常）"
fi

# ── 5. 输出配置片段 ──
if [[ "$MODE" == "node" ]]; then
    MCP_RUN=("node" "$INSTALL_DIR/mcp.js")
else
    MCP_RUN=("python3" "$INSTALL_DIR/cerebrate/mcp.py")
fi
MCP_CMD="${MCP_RUN[0]} ${MCP_RUN[1]}"

cat <<EOF

============================================================
🎉 安装完成！把下面配置片段粘贴到你的 AI 客户端（二选一）
============================================================

【1. Codex】（~/.codex/config.toml 的 [mcp_servers] 下加）
[mcp_servers.cerebrate]
command = "${MCP_RUN[0]}"
args = ["${MCP_RUN[1]}"]

【2. Claude Code】（~/.claude.json 的 mcpServers 或执行）
claude mcp add cerebrate -e "${MCP_RUN[0]}" -- "${MCP_RUN[1]}"

【3. Qoder】（~/.qoder/settings.json 的 mcpServers）
{
  "mcpServers": {
    "cerebrate": { "command": "${MCP_RUN[0]}", "args": ["${MCP_RUN[1]}"] }
  }
}

【4. opencode】（opencode.json）
{
  "mcp": {
    "cerebrate": { "type": "local", "command": ["${MCP_RUN[0]}", "${MCP_RUN[1]}"], "enabled": true }
  }
}

说明:
  - URL 与 token 已读自 $ENV_FILE（无需明文写进客户端配置）
  - 地址变化只需改 $ENV_FILE 里的 CEREBRATE_SERVER_URL
  - 重启 AI 客户端后，对话中先调用 cerebrate_sense 即可使用

============================================================
EOF

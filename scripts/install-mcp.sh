#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Cerebrate MCP 一键安装（同事端）
#
# 用法:
#   bash install-mcp.sh --url <脑虫地址> --token <你的user token>
#   curl -fsSL https://raw.githubusercontent.com/YaYII/Cerebrate/master/scripts/install-mcp.sh \
#     | bash -s -- --url https://... --token xxx
#
# 说明:
#   - 只安装 MCP 客户端（纯标准库，无需 pip 依赖）
#   - 生成 ~/.cerebrate-mcp/cerebrate.env（URL + token，chmod 600）
#   - 打印各客户端（Codex/Claude Code/Qoder/opencode）MCP 配置片段
#   - 完成后把配置片段粘贴到你的 AI 客户端即可使用
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── 参数 ──
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
  bash install-mcp.sh --url https://finale-earthworm-iciness.ngrok-free.dev/cerebrate --token f3ea02df761548e5808454c5aa2c231a
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

# ── 1. 检测 Python ──
if ! command -v python3 >/dev/null 2>&1; then
    err "未找到 python3，请先安装 Python 3.8+（https://www.python.org/downloads/）"
    exit 1
fi
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)'; then
    ok "Python ${PY_VER}（≥3.8，MCP 客户端纯标准库，无需 pip 依赖）"
else
    err "Python ${PY_VER} < 3.8，请升级"
    exit 1
fi

# ── 2. 获取代码 ──
if command -v git >/dev/null 2>&1; then
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        info "目录已存在，git pull 更新..."
        (cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null || true)
    else
        info "克隆 Cerebrate 仓库到 $INSTALL_DIR ..."
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    fi
else
    warn "未找到 git，改用下载压缩包..."
    mkdir -p "$INSTALL_DIR"
    TARBALL="$INSTALL_DIR/cerebrate.tar.gz"
    curl -fsSL "https://github.com/YaYII/Cerebrate/archive/refs/heads/master.tar.gz" -o "$TARBALL"
    tar -xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1
    rm -f "$TARBALL"
fi

# ── 3. 校验关键文件 ──
if [[ ! -f "$INSTALL_DIR/cerebrate/mcp.py" || ! -f "$INSTALL_DIR/cerebrate/entity.py" ]]; then
    err "安装目录缺少关键文件（cerebrate/mcp.py、cerebrate/entity.py），安装失败"
    exit 1
fi
ok "代码校验通过（mcp.py / entity.py 存在）"

# ── 4. 生成本地配置 env（URL + token）──
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
        warn "未提供 --url/--token，跳过 env 生成（之后可手动编辑 $ENV_FILE 或设环境变量）"
    fi
fi

# ── 5. 自检 ──
if command -v python3 >/dev/null 2>&1; then
    info "自检 MCP 客户端..."
    (cd "$INSTALL_DIR" && python3 -m cerebrate.mcp status) || \
        warn "自检未完全通过（若未配 URL/token 属正常），可继续粘贴配置使用"
fi

# ── 6. 输出配置片段 ──
MCP_SCRIPT="$INSTALL_DIR/cerebrate/mcp.py"
cat <<EOF

============================================================
🎉 安装完成！把下面配置片段粘贴到你的 AI 客户端（二选一）
============================================================

【1. Codex】（~/.codex/config.toml 的 [mcp_servers] 下加）
[mcp_servers.cerebrate]
command = "python3"
args = ["$MCP_SCRIPT"]

【2. Claude Code】（~/.claude.json 的 mcpServers 或执行）
claude mcp add cerebrate -e python3 -- "$MCP_SCRIPT"

【3. Qoder】（~/.qoder/settings.json 的 mcpServers）
{
  "mcpServers": {
    "cerebrate": { "command": "python3", "args": ["$MCP_SCRIPT"] }
  }
}

【4. opencode】（opencode.json）
{
  "mcp": {
    "cerebrate": { "type": "local", "command": ["python3", "$MCP_SCRIPT"], "enabled": true }
  }
}

说明:
  - URL 与 token 已读自 $ENV_FILE（无需明文写进客户端配置）
  - 若脑虫地址变化（如隧道重启），只需改 $ENV_FILE 里的 CEREBRATE_SERVER_URL
  - 常用工具：cerebrate_sense / cerebrate_search / cerebrate_detail /
    cerebrate_propose / cerebrate_auth_status；完整清单见 docs/MCP_GUIDE.md
  - 重启 AI 客户端后，对话中先调用 cerebrate_sense 即可开始使用
============================================================
EOF

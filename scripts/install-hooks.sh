#!/usr/bin/env bash
# ============================================================
# Cerebrate 客户端 hook 一键部署 — 工程化思维灵魂自动注入
# ============================================================
# 用法:
#   ./scripts/install-hooks.sh    # 部署到本机 Claude Code + Qoder
#   ./scripts/install-hooks.sh --check   # 只检查不部署
#
# 作用:
#   把「虫群灵魂」注入机制部署到本机 AI 客户端：
#   - Claude Code: ~/.claude/hooks/cerebrate-session-start.py（SessionStart）
#   - Qoder:       ~/.qoder/hooks/cerebrate-memory-inject.py（UserPromptSubmit）
#   - Codex:       ~/.codex/AGENTS.md 需含「工程化思维灵魂」章节（检测提示，不覆盖）
#
# 说明:
#   - hook 脚本不含硬编码机密，token 从 ~/Documents/project/Cerebrate/.env 或环境变量读取
#   - 服务端灵魂内容自动获取（GET /v1/soul），本脚本只部署注入机制
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$ROOT/scripts/hooks"

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

step() { echo "──────────────────────────────────────────────"; echo "▶ $1"; echo "──────────────────────────────────────────────"; }
ok()   { echo "  ✅ $1"; }
skip() { echo "  ⏭  $1"; }

install_hook() {
  local src="$1" dst_dir="$2" dst="$3" name="$4"
  if [ ! -f "$src" ]; then
    skip "$name 源文件缺失: $src"
    return
  fi
  if [ ! -d "$dst_dir" ]; then
    skip "$name 目标目录不存在: $dst_dir（未安装该客户端则跳过）"
    return
  fi
  if [ "$CHECK_ONLY" = "1" ]; then
    if [ -f "$dst" ] && grep -q "工程化思维灵魂" "$dst" 2>/dev/null; then
      ok "$name 已含灵魂注入"
    else
      echo "  ⚠️  $name 未含灵魂注入，需部署: $dst"
    fi
    return
  fi
  cp "$src" "$dst"
  chmod +x "$dst"
  ok "$name 已部署: $dst"
}

echo ""
echo "Cerebrate 客户端 hook 部署 $( [ "$CHECK_ONLY" = "1" ] && echo "(检查模式)" || echo "" )"
echo ""

step "1/3 Claude Code hook"
install_hook "$HOOKS_DIR/claude-session-start.py" "$HOME/.claude/hooks" "$HOME/.claude/hooks/cerebrate-session-start.py" "Claude Code"

step "2/3 Qoder hook"
install_hook "$HOOKS_DIR/qoder-memory-inject.py" "$HOME/.qoder/hooks" "$HOME/.qoder/hooks/cerebrate-memory-inject.py" "Qoder"

step "3/3 Codex AGENTS.md"
CODEX_AGENTS="$HOME/.codex/AGENTS.md"
if [ -f "$CODEX_AGENTS" ]; then
  if grep -q "工程化思维灵魂" "$CODEX_AGENTS" 2>/dev/null; then
    ok "Codex AGENTS.md 已含灵魂章节"
  else
    echo "  ⚠️  Codex AGENTS.md 未含灵魂章节，需手动追加（本脚本不覆盖用户自定义内容）："
    echo "     参考 docs/ENGINEERING_SOUL.md 或全局 v2.2 模板追加「工程化思维灵魂」章节"
  fi
else
  skip "Codex AGENTS.md 不存在: $CODEX_AGENTS"
fi

echo ""
if [ "$CHECK_ONLY" = "1" ]; then
  echo "检查完成。部署后每个 AI 会话开始自动注入工程化思维灵魂。"
else
  echo "✅ 部署完成。Claude Code / Qoder 下次会话开始自动注入「工程化思维灵魂」。"
  echo "   Codex 每次会话自动加载 AGENTS.md（灵魂章节需已存在）。"
fi

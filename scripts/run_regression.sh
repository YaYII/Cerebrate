#!/usr/bin/env bash
# Cerebrate 一键回归脚本（2026-08-07，用户要求：方便做回归测试确保稳定性）
#
# 覆盖：
#   1. Python / Node 语法检查
#   2. MCP 工具三方一致性（服务端 mcp_transport ↔ 本地 mcp.py ↔ mcp.js）
#   3. 全量单元测试（零 LLM 付费：conftest 已清 key）
#   4. 本地 MCP 客户端新工具分发
#   5. 脑虫服务健康检查（在线时）
#
# 用法：
#   bash scripts/run_regression.sh          # 完整回归
#   bash scripts/run_regression.sh --fast   # 仅语法+工具一致性（秒级）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 服务健康检查 token：优先环境变量，其次 .env（不修改 .env，仅读取）
TOKEN="${CEREBRATE_SERVER_TOKEN:-}"
if [[ -z "$TOKEN" && -f .env ]]; then
  TOKEN="$(grep -E '^CEREBRATE_SERVER_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi

echo "======================================"
echo " Cerebrate 回归测试 $(cat VERSION 2>/dev/null || echo '?')"
echo "======================================"

step() { echo ""; echo "── $1 ──"; }

# ── 1. 语法检查 ──
step "1/5 Python + Node 语法检查"
python3 -m py_compile \
  cerebrate/mcp.py \
  cerebrate/server/mcp_transport.py \
  cerebrate/server/api.py \
  cerebrate/server/http.py \
  cerebrate/memory/scene.py \
  cerebrate/memory/swarm.py \
  cerebrate/memory/personal.py \
  cerebrate/memory/manager.py \
  cerebrate/brain/llm.py \
  cerebrate/config.py
echo "  Python OK"
node --check mcp.js
echo "  Node OK"

if [[ "${1:-}" == "--fast" ]]; then
  step "快速模式：跳过全量测试"
  echo "完成。"
  exit 0
fi

# ── 2. MCP 工具三方一致性 ──
step "2/5 MCP 工具三方一致性"
python3 -m pytest tests/test_mcp_tool_parity.py tests/test_mcp_local_dispatch.py -q

# ── 3. 全量单元测试 ──
step "3/5 全量单元测试（零 LLM 付费）"
python3 -m pytest tests/ -q --ignore=tests/prod_test.py

# ── 4. 服务健康检查（可选，服务未启动则跳过） ──
step "4/5 脑虫服务健康检查"
if curl -sf -m 5 -H "Authorization: Bearer ${TOKEN}" \
    http://127.0.0.1:8765/v1/sense >/dev/null 2>&1; then
  curl -sf -m 10 -H "Authorization: Bearer ${TOKEN}" \
    http://127.0.0.1:8765/v1/sense | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print('  服务在线:', d['status'], '| total:', d['data']['total_memories'])"
else
  echo "  服务未启动（跳过；启动方式: docker compose up -d）"
fi

echo ""
echo "======================================"
echo " ✅ 回归完成"
echo "======================================"

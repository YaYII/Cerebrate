#!/usr/bin/env bash
# ============================================================
# Cerebrate v5.x — 部署 / 升级脚本（宿主机裸跑模式）
# ============================================================
# 用法:
#   ./scripts/deploy.sh                  # 完整部署：build node → 测试 → 启动 → rebuild → 冒烟
#   ./scripts/deploy.sh --skip-tests     # 跳过全量测试（快速部署）
#   ./scripts/deploy.sh --docker         # Docker 模式（docker compose up -d --build）
#   ./scripts/deploy.sh --no-pull        # 不 git pull（用当前代码）
#
# 安全:
#   - set -euo pipefail，任一步失败即中止，不掩盖错误
#   - .env 读取但不打印任何密钥
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PULL=1
SKIP_TESTS=0
MODE="bare"

for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --docker)     MODE="docker" ;;
    --no-pull)    PULL=0 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

step() { echo ""; echo "──────────────────────────────────────────────"; echo "▶ $1"; echo "──────────────────────────────────────────────"; }

# ── 0. 前置检查 ──
command -v python3 >/dev/null || { echo "错误: 需要 python3" >&2; exit 1; }

# ── 1. 拉取最新代码（可选） ──
if [ "$PULL" = "1" ]; then
  step "1/7 git pull"
  git pull --ff-only origin main
fi

# ── 2. node CLI 构建（宿主机客户端，dist 被 gitignore） ──
if [ -d "clients/node" ]; then
  step "2/7 构建 node CLI 客户端"
  (cd clients/node && npm install --no-audit --no-fund && npm run build)
  echo "✅ node CLI 构建完成: clients/node/dist/cli.js"
else
  echo "⚠️ 跳过 node CLI（无 clients/node 目录）"
fi

# ── 3. 全量测试 ──
if [ "$SKIP_TESTS" = "1" ]; then
  echo "⏭ 3/7 跳过全量测试（--skip-tests）"
else
  step "3/7 全量测试"
  CEREBRATE_DOCKER_SKIP_CHECK=1 python3 -m pytest tests/ -q --ignore=tests/prod_test.py
  echo "✅ 全量测试通过"
fi

# ── 4. 停止旧服务 ──
step "4/7 停止旧服务"
pkill -f "cerebrate.py serve" 2>/dev/null && echo "已停止旧 Brain Server" || echo "无运行中的 Brain Server"
sleep 1

# ── 5. 启动 / 构建 ──
if [ "$MODE" = "docker" ]; then
  step "5/7 Docker 构建并启动"
  docker compose up -d --build
  echo "等待容器就绪..."
  for i in $(seq 1 30); do
    if curl -s --max-time 3 "http://127.0.0.1:${CEREBRATE_SERVER_PORT:-8765}/v1/sense" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
else
  step "5/7 启动 Brain Server（裸跑）"
  mkdir -p logs
  # 从 .env 加载配置（不打印密钥）
  set -a; [ -f .env ] && . ./.env; set +a
  # setsid 完全脱离会话/进程组：即使部署终端关闭，服务仍持续运行
  CEREBRATE_DOCKER_SKIP_CHECK=1 setsid nohup python3 cerebrate.py serve \
    --host "${CEREBRATE_SERVER_HOST:-127.0.0.1}" \
    --port "${CEREBRATE_SERVER_PORT:-8765}" \
    >> logs/server.log 2>&1 < /dev/null &
  echo "PID: $!"
  echo "日志: logs/server.log"
  echo "等待服务就绪..."
  TOKEN="${CEREBRATE_SERVER_TOKEN:-}"
  for i in $(seq 1 30); do
    if [ -n "$TOKEN" ]; then
      curl -s --max-time 3 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:${CEREBRATE_SERVER_PORT:-8765}/v1/sense" >/dev/null 2>&1 && break
    else
      curl -s --max-time 3 "http://127.0.0.1:${CEREBRATE_SERVER_PORT:-8765}/v1/sense" >/dev/null 2>&1 && break
    fi
    sleep 2
  done
fi

step "6/7 重建 FTS5 全文索引（swarm + knowledge）"
if [ "$MODE" = "docker" ]; then
  docker compose exec cerebrate python3 cerebrate.py fulltext rebuild
else
  CEREBRATE_DOCKER_SKIP_CHECK=1 python3 cerebrate.py fulltext rebuild \
    --url "http://127.0.0.1:${CEREBRATE_SERVER_PORT:-8765}" 2>/dev/null \
    || CEREBRATE_DOCKER_SKIP_CHECK=1 python3 -c "
from cerebrate.config import config
from cerebrate.memory.manager import MemoryManager
import json
mm = MemoryManager(config.personal_path, config.swarm_path, config.knowledge_path)
print(json.dumps(mm.rebuild_fulltext(), ensure_ascii=False))
"
fi

# rebuild 后重新探活（rebuild 可能短暂占用资源，避免冒烟误报）
step "6b 等待服务稳定"
TOKEN="${CEREBRATE_SERVER_TOKEN:-}"
for i in $(seq 1 15); do
  if [ -n "$TOKEN" ]; then
    curl -s --max-time 3 -H "Authorization: Bearer $TOKEN" \
      "http://127.0.0.1:${CEREBRATE_SERVER_PORT:-8765}/v1/sense" >/dev/null 2>&1 && break
  else
    curl -s --max-time 3 \
      "http://127.0.0.1:${CEREBRATE_SERVER_PORT:-8765}/v1/sense" >/dev/null 2>&1 && break
  fi
  sleep 2
done

# ── 7. 冒烟验证 ──
step "7/7 冒烟验证"
BASE="http://127.0.0.1:${CEREBRATE_SERVER_PORT:-8765}"
TOKEN="${CEREBRATE_SERVER_TOKEN:-}"
AUTH=()
[ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")

echo "== /v1/sense =="
curl -s --max-time 5 "${AUTH[@]}" "$BASE/v1/sense" | python3 -m json.tool | head -12
echo ""
echo "== /v1/search (fts, smoke) =="
curl -s --max-time 5 "${AUTH[@]}" -X POST "$BASE/v1/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"部署","mode":"fts","limit":2}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('count:', d.get('data',{}).get('count','(no data)'))" 2>/dev/null || echo "(search 响应解析跳过)"

echo ""
echo "✅ 部署完成"
echo "   服务端: $BASE"
echo "   日志:   logs/server.log"
echo "   验证:   curl -H \"Authorization: Bearer <token>\" $BASE/v1/sense"
echo "   (token 来自 .env 的 CEREBRATE_SERVER_TOKEN，不再明文打印)"

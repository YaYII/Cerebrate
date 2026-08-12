#!/usr/bin/env bash
# ============================================================
# Cerebrate 公网网关一键管理 — 本机 = 公网服务器
# ============================================================
# 架构:
#   公网用户 → ngrok 隧道 → 本地 Nginx 网关(8443)
#     → /cerebrate/ → Cerebrate 容器(8765)
#     → /<其他项目>/ → 扩展（编辑 docker/nginx-gateway/nginx.conf）
#   ⚠️ 端口 8443 避开宿主 80/443（ihm-online-proxy 等正式项目 nginx 占用）
#
# 用法:
#   ./scripts/tunnel-gateway.sh start    # 启动网关+隧道，并自动验证公网可用（隧道不通自动重启自愈）
#   ./scripts/tunnel-gateway.sh stop     # 停止隧道+网关
#   ./scripts/tunnel-gateway.sh status   # 查看当前 URL、进程与公网连通性
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-status}"
NGINX_NAME="nginx-gateway"

# 从 ngrok 本地 API 取当前隧道公网 URL（无隧道返回空）
get_tunnel_url() {
  curl -s --max-time 3 http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    ts=[t.get('public_url','') for t in d.get('tunnels',[]) if t.get('public_url')]
    print(ts[0] if ts else '')
except Exception:
    print('')
"
}

# 公网探测：/cerebrate/v1/sense 返回 401（无 Bearer 鉴权拦截）或 200 即视为链路通
tunnel_probe() {
  local url="$1" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "${url}/cerebrate/v1/sense" 2>/dev/null || true)
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then
    echo "   ✅ 隧道就绪: ${url}"
    echo "      Cerebrate: ${url}/cerebrate/v1/sense (HTTP ${code} = 链路通)"
    return 0
  fi
  echo "   ⏳ 公网探测异常 (HTTP ${code:-无响应})，继续等待…"
  return 1
}

# 单轮等待隧道就绪：轮询 4040 拿到 URL 后做公网探测，$1 秒内未通返回 1
wait_tunnel() {
  local timeout="${1:-20}" url deadline
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    url=$(get_tunnel_url)
    if [ -n "$url" ] && tunnel_probe "$url"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# 隧道就绪自愈：最多 $2 轮，每轮等 $1 秒；未通则 kill+重启 ngrok 再试
tunnel_ready() {
  local timeout="${1:-20}" max_rounds="${2:-3}" round=1
  while [ "$round" -le "$max_rounds" ]; do
    echo "   ── 隧道就绪检查（第 ${round}/${max_rounds} 轮，单轮最长 ${timeout}s）──"
    if wait_tunnel "$timeout"; then
      return 0
    fi
    if [ "$round" -lt "$max_rounds" ]; then
      echo "   ⚠️  隧道未通，重启 ngrok 重试…"
      pkill -x ngrok 2>/dev/null || true
      sleep 1
      setsid nohup ngrok http 8443 --log=stdout > /tmp/ngrok_gateway.log 2>&1 < /dev/null & disown 2>/dev/null
    fi
    round=$((round + 1))
  done
  echo "   ❌ 多次重启后隧道仍未就绪，详见 /tmp/ngrok_gateway.log"
  return 1
}

# 确保 ngrok 运行且隧道可用；已通则不动，未通/未运行则拉起
ensure_ngrok() {
  if pgrep -x ngrok >/dev/null 2>&1; then
    local url
    url=$(get_tunnel_url)
    if [ -n "$url" ] && tunnel_probe "$url"; then
      echo "   ✅ ngrok 已在运行且隧道可用，无需重启"
      return 0
    fi
    echo "   ⚠️  ngrok 进程在但隧道不通，清理重启"
    pkill -x ngrok
    sleep 1
  fi
  # 记忆坑位：pkill -x（勿 -f 自匹配）+ setsid 保活 + < /dev/null 防阻塞
  setsid nohup ngrok http 8443 --log=stdout > /tmp/ngrok_gateway.log 2>&1 < /dev/null & disown 2>/dev/null
}

start() {
  echo "▶ 1/2 启动 Nginx 网关容器"
  if docker ps --format '{{.Names}}' | grep -q "^${NGINX_NAME}$"; then
    echo "   ✅ 网关已运行"
  else
    # DSEDT Admin 静态挂载（nginx.conf 中 /admin/ 指向该目录）
    # 宿主 8443 → 容器 80（容器内 nginx 仍 listen 80，仅宿主端口隔离）
    docker run -d --name "$NGINX_NAME" \
      --network cerebrate_default \
      -p 127.0.0.1:8443:80 \
      -v "$ROOT/docker/nginx-gateway/nginx.conf:/etc/nginx/nginx.conf:ro" \
      -v "/home/as-workstation01/Documents/project/DSEDT/verification-platform/frontend/admin/dist:/usr/share/nginx/admin:ro" \
      --restart unless-stopped nginx:alpine
    echo "   ✅ 网关已启动"
    sleep 3
  fi

  echo "▶ 2/2 启动 ngrok 隧道 → 网关 8443"
  ensure_ngrok
  # 关键：启动后必须验证公网真实可用，隧道未通自动重启自愈；仍失败则退出非 0
  if ! tunnel_ready 20 3; then
    echo "❌ 启动未完成：公网隧道未就绪"
    exit 1
  fi
  status
}

stop() {
  echo "▶ 停止隧道与网关"
  pkill -x ngrok 2>/dev/null && echo "   ✅ ngrok 已停止" || echo "   ⏭ ngrok 未运行"
  docker rm -f "$NGINX_NAME" 2>/dev/null && echo "   ✅ 网关已停止" || echo "   ⏭ 网关未运行"
}

status() {
  echo "▶ 当前状态"
  pgrep -x ngrok >/dev/null 2>&1 && echo "   ngrok: 运行中" || echo "   ngrok: 未运行"
  docker ps --format '{{.Names}} {{.Status}}' | grep "^${NGINX_NAME}" || echo "   网关: 未运行"
  echo "   ── 公网 URL ──"
  local url
  url=$(get_tunnel_url)
  if [ -n "$url" ]; then
    echo "   $url"
    echo "   Cerebrate: $url/cerebrate/v1/sense"
    tunnel_probe "$url" || echo "   ❌ 公网探测失败：隧道可能已失效，执行 start 可自愈"
  else
    echo "   (无隧道) — 执行 start 可拉起"
  fi
  # 保留多隧道完整列表（便于扩展）
  curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
ts=[t for t in d.get('tunnels',[]) if t.get('public_url')]
if ts:
    for t in ts:
        if t['public_url'] != '$url':
            print('   (extra) ' + t['public_url'] + '  →  ' + t.get('config',{}).get('addr',''))
" 2>/dev/null || true
}

case "$ACTION" in
  start) start ;;
  stop)  stop ;;
  status) status ;;
  *) echo "用法: $0 start|stop|status"; exit 1 ;;
esac

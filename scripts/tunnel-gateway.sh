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
#   ./scripts/tunnel-gateway.sh start    # 启动网关+隧道，打印公网 URL
#   ./scripts/tunnel-gateway.sh stop     # 停止隧道+网关
#   ./scripts/tunnel-gateway.sh status   # 查看当前 URL 与进程
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-status}"
NGINX_NAME="nginx-gateway"

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
  if pgrep -x ngrok >/dev/null 2>&1; then
    echo "   ⚠️  ngrok 已在运行（可能指向旧端口），先清理"
    pkill -x ngrok; sleep 1
  fi
  # 记忆坑位：pkill -x（勿 -f 自匹配）+ setsid 保活 + < /dev/null 防阻塞
  setsid nohup ngrok http 8443 --log=stdout > /tmp/ngrok_gateway.log 2>&1 < /dev/null & disown 2>/dev/null
  sleep 8
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
  curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
ts=[t for t in d.get('tunnels',[]) if t.get('public_url')]
if ts:
    for t in ts:
        print('   ' + t['public_url'] + '  →  ' + t.get('config',{}).get('addr',''))
        print('   Cerebrate: ' + t['public_url'] + '/cerebrate/v1/sense')
else:
    print('   (无隧道)')
" 2>/dev/null || echo "   (隧道信息不可用)"
}

case "$ACTION" in
  start) start ;;
  stop)  stop ;;
  status) status ;;
  *) echo "用法: $0 start|stop|status"; exit 1 ;;
esac

#!/usr/bin/env bash
# ============================================================
# Cerebrate 公网隧道常驻守护 — 根治「ngx 启动了但隧道没通」
# ============================================================
# 背景（2026-08-13 复盘）：tunnel-gateway.sh 的自愈只在 start 时生效，
# ngrok 是宿主进程（容器 restart 策略管不到），运行中自退后无人拉起。
# 本守护由 cron 每 5 分钟唤醒一次，三重探测：
#   ① ngrok 进程存活  ② 4040 API 能拿到隧道 URL  ③ 公网 /cerebrate/v1/sense 返回 401/200
# 任一不满足 → 调用 tunnel-gateway.sh start（内部 ensure_ngrok + tunnel_ready 公网验证自愈）。
# flock 防并发：上一轮还在自愈中则跳过本轮（下轮再查）。
#
# 用法:
#   ./scripts/tunnel-watchdog.sh check   # 探测+自愈（cron 调用入口）
#   ./scripts/tunnel-watchdog.sh status  # 只看当前健康状态
# 安装（一次性）:
#   ( crontab -l 2>/dev/null; echo "*/5 * * * * /home/as-workstation01/Documents/project/Cerebrate/scripts/tunnel-watchdog.sh check >> /tmp/tunnel_watchdog.log 2>&1" ) | crontab -
# ============================================================
set -uo pipefail

# cron 环境 PATH 精简，补全 ngrok(snap)/docker/curl/python3 等
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-check}"
LOG="/tmp/tunnel_watchdog.log"

ts() { date '+%F %T'; }

# 从 ngrok 本地 API 取当前隧道公网 URL（无隧道返回空）
tunnel_url() {
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

# 公网探测：/cerebrate/v1/sense 返回 401（无 Bearer 鉴权拦截）或 200 即链路通
probe() {
  local url="$1" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "${url}/cerebrate/v1/sense" 2>/dev/null || true)
  [ "$code" = "401" ] || [ "$code" = "200" ]
}

# 三重健康检查：进程 + 4040 URL + 公网探测，全部通过才返回 0
health_ok() {
  pgrep -x ngrok >/dev/null 2>&1 || return 1
  local url
  url=$(tunnel_url)
  [ -n "$url" ] || return 1
  probe "$url" || return 1
  return 0
}

check() {
  # flock -n 非阻塞：已有实例在自愈则本轮直接退出
  exec 9>"/tmp/tunnel_watchdog.lock"
  flock -n 9 || { echo "$(ts) [skip] another watchdog instance running"; exit 0; }

  if health_ok; then
    echo "$(ts) [ok] tunnel healthy: $(tunnel_url)"
    return 0
  fi

  echo "$(ts) [warn] tunnel DOWN (process/4040/probe check failed), invoking self-heal…"
  # 子 shell 先关闭锁 fd 9（9>&-），防止 tunnel-gateway.sh 内 setsid nohup ngrok
  # 继承 flock 锁句柄长期持有，导致后续 check 全部 [skip] 永不自愈
  ( "$ROOT/scripts/tunnel-gateway.sh" start ) 9>&-
  if health_ok; then
    echo "$(ts) [recovered] tunnel restored: $(tunnel_url)"
  else
    echo "$(ts) [fail] self-heal failed, will retry next cycle"
    return 1
  fi
}

status() {
  if health_ok; then
    echo "[ok] ngrok running, tunnel: $(tunnel_url)"
  else
    echo "[down] ngrok process: $(pgrep -x ngrok >/dev/null 2>&1 && echo alive || echo dead), 4040: $(curl -s --max-time 3 http://127.0.0.1:4040/api/tunnels >/dev/null 2>&1 && echo up || echo down)"
  fi
}

case "$ACTION" in
  check) check ;;
  status) status ;;
  *) echo "用法: $0 check|status"; exit 1 ;;
esac

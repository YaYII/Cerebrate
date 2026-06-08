#!/bin/bash
# Cerebrate v5 — Docker 容器入口脚本
# 负责初始化数据目录、修复权限、然后启动脑虫服务。
set -e

DATA_DIR="${CEREBRATE_MEMORY_ROOT:-/data}"

echo "[entrypoint] Cerebrate v5 脑虫服务初始化"
echo "[entrypoint] 数据目录: ${DATA_DIR}"

# ── 1. 确保数据目录存在 ──
mkdir -p "${DATA_DIR}"/{chroma_data,personal,swarm,knowledge,agents,events,evolution}

# ── 2. 确保 /data 可写 ──
if [ ! -w "${DATA_DIR}" ]; then
    echo "[entrypoint] 错误: ${DATA_DIR} 不可写，请检查挂载权限"
    exit 1
fi

# ── 3. 数据目录完整性检查 ──
if [ -f "${DATA_DIR}/chroma_data/chroma.sqlite3" ]; then
    # 已有 ChromaDB 数据，快速校验
    SQLITE_OK=$(python3 -c "
import sqlite3, sys
try:
    conn = sqlite3.connect('${DATA_DIR}/chroma_data/chroma.sqlite3')
    conn.execute('SELECT COUNT(*) FROM collections')
    conn.close()
    print('ok')
except Exception:
    print('corrupt')
" 2>/dev/null || echo "unknown")
    
    if [ "$SQLITE_OK" = "corrupt" ]; then
        echo "[entrypoint] ⚠️ 警告: ChromaDB 数据库可能损坏，建议重建或从备份恢复"
    elif [ "$SQLITE_OK" = "ok" ]; then
        MEM_COUNT=$(python3 -c "
import sqlite3
try:
    conn = sqlite3.connect('${DATA_DIR}/chroma_data/chroma.sqlite3')
    cur = conn.execute('SELECT COUNT(*) FROM collections')
    print(cur.fetchone()[0])
    conn.close()
except Exception:
    print('0')
" 2>/dev/null || echo "?")
        echo "[entrypoint] ✅ ChromaDB 正常，${MEM_COUNT} 个集合"
    fi
else
    echo "[entrypoint] 首次启动，数据目录为空"
fi

# ── 4. 检查环境变量完整性 ──
if [ -z "${CEREBRATE_SERVER_TOKEN}" ]; then
    echo "[entrypoint] ⚠️ 警告: CEREBRATE_SERVER_TOKEN 未设置，服务将不启用鉴权"
    echo "[entrypoint]    生产环境请务必设置此值"
fi

# ── 5. 修正数据目录所有权（bind mount 可能属主不匹配）──
CEREBRATE_UID=${CEREBRATE_UID:-1000}
CEREBRATE_GID=${CEREBRATE_GID:-1000}
chown -R "${CEREBRATE_UID}:${CEREBRATE_GID}" "${DATA_DIR}"

# ── 6. 启动脑虫服务（降权到 cerebrate 用户） ──
echo "[entrypoint] 🧠 脑虫服务启动中..."
echo "[entrypoint] 监听: ${CEREBRATE_SERVER_HOST:-0.0.0.0}:${CEREBRATE_SERVER_PORT:-8765}"

exec gosu "${CEREBRATE_UID}:${CEREBRATE_GID}" python3 /app/cerebrate.py serve

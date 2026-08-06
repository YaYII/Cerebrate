# Cerebrate v5 脑虫 Brain Server — 生产容器镜像
# 权威记忆中枢，独立运行；MCP / CLI 客户端通过 HTTP + Bearer token 远程连接。
# ============================================================
# 构建:  docker compose build
# 运行:  docker compose up -d
# 验证:  curl http://127.0.0.1:8765/v1/sense

FROM python:3.12-slim AS base

# ── 系统依赖 ──
# chromadb / onnxruntime 需要 libgomp
# gosu 用于安全降权（entrypoint 以 root 初始化后切换到 cerebrate 用户）
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 gosu \
    && rm -rf /var/lib/apt/lists/*

# ── Python 依赖 ──
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models

WORKDIR /app

# 先装 CPU-only torch，避免 sentence-transformers 拉入体积庞大的 CUDA 版
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch

# 再装其余依赖；pip 见 torch 已满足约束便不会重装
COPY requirements.txt ./
RUN pip install -r requirements.txt

# 构建阶段预下载 BGE 模型（与 docker-compose.yml 的 CEREBRATE_EMBEDDING_MODEL 一致），
# 固化进镜像层，运行时离线读取（CEREBRATE_EMBEDDING_ALLOW_DOWNLOAD=false）
# 注意：模型维度必须与已有 ChromaDB 数据一致（512 维），否则 storage.py 会
# 因 embedding function mismatch 执行 delete_collection 清空向量数据！
# 同时下载 ReRanker 交叉编码器用于精排
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-small-zh-v1.5')"
RUN python -c "from sentence_transformers import CrossEncoder; CrossEncoder('BAAI/bge-reranker-v2-m3')" \
    || echo 'ReRanker 下载失败（可选，服务端降级为不重排）'

# ── 创建非 root 用户 ──
RUN groupadd --gid 1000 cerebrate \
    && useradd --uid 1000 --gid cerebrate --home-dir /app --no-create-home cerebrate

# ── 复制应用代码 ──
# .dockerignore 排除了 node 客户端、测试、文档等
COPY cerebrate.py ./
COPY cerebrate ./cerebrate
COPY docker-entrypoint.sh /docker-entrypoint.sh

# MCP 客户端分发包（供 /mcp/* 下载端点，容器内仅静态托管不运行）
COPY mcp.js /app/mcp.js
COPY VERSION /app/VERSION
COPY Dockerfile.mcp /app/Dockerfile.mcp
COPY scripts/install-mcp.sh /app/scripts/install-mcp.sh
RUN chmod +x /docker-entrypoint.sh

# ── 容器运行时默认配置 ──
# docker-compose.yml 会覆盖 HOST/PORT/MEMORY_ROOT
ENV CEREBRATE_SERVER_HOST=0.0.0.0 \
    CEREBRATE_SERVER_PORT=8765 \
    CEREBRATE_MEMORY_ROOT=/data \
    CEREBRATE_EMBEDDING_ALLOW_DOWNLOAD=false \
    CEREBRATE_EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5 \
    CEREBRATE_EMBEDDING_MAX_LENGTH=8192 \
    CEREBRATE_EMBEDDING_HASH_DIM=1024

EXPOSE 8765
VOLUME ["/data"]

# slim 镜像无 curl，用 python urllib 带 token 探活 /v1/sense
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python3 -c "import os,urllib.request as u; t=os.environ.get('CEREBRATE_SERVER_TOKEN',''); h={'Authorization':'Bearer '+t} if t else {}; u.urlopen(u.Request('http://127.0.0.1:8765/v1/sense',headers=h),timeout=4)" || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]

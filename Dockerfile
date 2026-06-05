# Cerebrate v5 脑虫 Brain Server — 容器镜像
# 权威记忆中枢，独立运行；MCP / CLI 客户端通过 HTTP + Bearer token 远程连接。
FROM python:3.12-slim

# 运行时所需的系统依赖（chromadb / onnxruntime 需要 libgomp）
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models

WORKDIR /app

# 先装 CPU-only torch，避免 sentence-transformers 拉入体积庞大的 CUDA 版
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch

# 再装其余依赖；pip 见 torch 已满足约束便不会重装
COPY requirements.txt ./
RUN pip install -r requirements.txt

# 构建阶段预下载 BGE 模型，固化进镜像层，运行时离线读取
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-small-zh-v1.5')"

# 复制服务端运行所需代码（数据目录与 node 客户端由 .dockerignore 排除）
COPY cerebrate.py ./
COPY cerebrate ./cerebrate

# 容器运行时默认配置
ENV CEREBRATE_SERVER_HOST=0.0.0.0 \
    CEREBRATE_SERVER_PORT=8765 \
    CEREBRATE_MEMORY_ROOT=/data \
    CEREBRATE_EMBEDDING_ALLOW_DOWNLOAD=false

EXPOSE 8765
VOLUME ["/data"]

# slim 镜像无 curl，用 python urllib 带 token 探活 /v1/sense
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python3 -c "import os,urllib.request as u; t=os.environ.get('CEREBRATE_SERVER_TOKEN',''); h={'Authorization':'Bearer '+t} if t else {}; u.urlopen(u.Request('http://127.0.0.1:8765/v1/sense',headers=h),timeout=4)" || exit 1

ENTRYPOINT ["python3", "cerebrate.py", "serve"]

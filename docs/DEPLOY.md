# Cerebrate 脑虫容器化部署

把权威脑虫服务端（Brain Server）打包成 Docker 容器独立运行，其他 MCP / CLI 客户端通过 HTTP + Bearer token 远程连接。

> **部署原则（2026-08-03 确认）**：Docker 是**目标部署方式**（环境隔离、依赖固化、可移植）。
> 宿主机裸跑仅用于临时调试，不作为正式部署。

> **快速开始（30 秒）**
> ```bash
> cd /home/as-workstation01/Documents/project/Cerebrate
> docker compose up -d --build
> curl http://127.0.0.1:8765/v1/sense
> ```

## 架构

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ 宿主机 / 局域网内的客户端    │        │ Docker 容器: cerebrate:5.0.2  │
│                             │        │                              │
│  cerebrate.py  (CLI)  ──────┼──HTTP──┼─▶ Brain Server :8765         │
│  cerebrate/mcp.py (MCP) ────┤ +token │   BrainAPI + ChromaDB + BGE  │
│                             │        │   数据卷 cerebrate-data:/data │
└─────────────────────────────┘        └──────────────────────────────┘
```

- 服务端在容器内监听 `0.0.0.0:8765`，挂载宿主机目录（由 `.env` 的 `CEREBRATE_DATA_DIR` 指定）到 `/data` 持久化全部记忆。
- 鉴权：`CEREBRATE_SERVER_TOKEN` 非空时，服务端对所有请求强制校验 `Authorization: Bearer <token>`。
- Embedding：BGE 模型（`BAAI/bge-small-zh-v1.5`）已在构建时打包进镜像，运行时离线加载（512 维）。

## 一、构建并启动

> 当前镜像 tag：**cerebrate:5.0.2**（与 MCP 版本 cerebrate-mcp 5.0.2 统一；
> 协议标识 `meta.protocol` 保持 v5 不变）。

```bash
cp .env.example .env
# 编辑 .env：
#   CEREBRATE_SERVER_TOKEN=<openssl rand -hex 32 生成的强随机值>
#   ANTHROPIC_API_KEY=sk-ant-...   # 可选，启用 LLM 免疫系统；不填则降级
docker compose up -d --build
```

版本升级（镜像 tag 变更，如 5.0.1 → 5.1.0）：
```bash
# 1. 修改 docker-compose.yml 的 image: cerebrate:<新版本>
# 2. 同步版本号（5 处）：VERSION 文件 / mcp_transport.py SERVER_INFO /
#    mcp.py serverInfo / mcp.js（两处硬编码）/ package.json
# 3. 重建并升级
docker compose build && docker compose up -d
# 4. 清理旧镜像
docker rmi cerebrate:<旧版本>
```

查看启动日志，确认服务就绪且使用 BGE 而非 hash 回退：

```bash
docker compose logs -f cerebrate
# 期望: {"status":"ok","data":{"base_url":"http://0.0.0.0:8765"},...}
# 期望日志含 "嵌入引擎: BGE"
docker compose ps   # STATUS 应为 healthy
```

### 网络范围

`docker-compose.yml` 默认 `ports: "127.0.0.1:8765:8765"`，仅暴露到宿主机本地回环。
局域网访问改为：

```yaml
    ports:
      - "8765:8765"              # 所有网卡
      # 或绑定指定内网 IP：
      # - "192.168.1.10:8765:8765"
```

## 二、CLI 客户端连接

在宿主机（或局域网任意机器）上设置环境变量后照常使用：

```bash
export CEREBRATE_SERVER_URL=http://<容器宿主机IP>:8765   # 本机即 127.0.0.1
export CEREBRATE_SERVER_TOKEN=<与服务端相同的令牌>

python3 cerebrate.py sense        # → {"status":"ok",...}
python3 cerebrate.py query "如何修复导入顺序" --user yangying
```

> CLI 的 `client_request()` 会自动把 `CEREBRATE_SERVER_TOKEN` 注入 `Authorization` 头（见 `cerebrate/client/cli.py`）。

## 三、MCP 客户端集成

`cerebrate/mcp.py` 是零依赖（仅标准库）的 stdio MCP server，作为**瘦客户端**在宿主机运行，内部通过 HTTP 连容器。在 MCP 宿主（Claude Code / Codex 等）的配置中加入：

```json
{
  "mcpServers": {
    "cerebrate": {
      "command": "python3",
      "args": ["/绝对路径/Cerebrate/cerebrate/mcp.py"],
      "env": {
        "CEREBRATE_SERVER_URL": "http://127.0.0.1:8765",
        "CEREBRATE_SERVER_TOKEN": "<与服务端相同的令牌>"
      }
    }
  }
}
```

`mcp.py` 已无 cerebrate 包依赖，可单独拷贝该文件到任意机器运行，只要能访问容器端口即可。

## 三-b、客户端「工程化思维灵魂」注入部署（v2.2+）

每个接入虫群的 AI 客户端，都会在会话开始自动注入「工程化思维灵魂」
（证据优先 / 开工前调研 / 最小修改 / 验证结果 / 总结交接）。
灵魂内容由服务端统一维护（`GET /v1/soul`，scope=general），客户端只需部署注入机制。

```bash
# 一键部署到本机 Claude Code + Qoder（hook 脚本在 scripts/hooks/）
./scripts/install-hooks.sh

# 只检查不部署
./scripts/install-hooks.sh --check
```

部署内容：
- Claude Code：`~/.claude/hooks/cerebrate-session-start.py`（SessionStart 事件）
- Qoder：`~/.qoder/hooks/cerebrate-memory-inject.py`（UserPromptSubmit 事件）
- Codex：`~/.codex/AGENTS.md` 需含「工程化思维灵魂」章节（脚本检测提示，不覆盖用户内容）

> 其他设备：`git pull` 拉取仓库 → 运行 `./scripts/install-hooks.sh` 即可。
> hook 脚本不含硬编码机密（token 从 `.env` 读取），可安全入库分发。

## 四、迁移已有记忆（可选）

容器使用全新空 volume 从零建库。如需把宿主机本地已有记忆迁入容器，注意**维度差异**：本地 `chroma_data` 若由 hash(384 维) 建库，与容器 BGE(512 维) 不兼容，不能直接拷贝 `chroma_data`，必须经 seed 重建：

```bash
# 1) 在宿主机本地（裸跑）导出种子
python3 cerebrate.py migrate --export-seeds      # 生成 memory/seeds/*.jsonl

# 2) 把种子拷进容器数据卷后，在容器内用 BGE 重新索引
docker compose exec cerebrate python3 cerebrate.py migrate --reindex
```

## 五、跨网 / 公网部署

本方案只用 Bearer token，不含 TLS。若客户端需经公网连接，请在容器前置反向代理（Caddy / nginx）终止 TLS，并仅经 HTTPS 转发到容器端口。token 仍作为第二道防线。

## 六、运维命令

```bash
# 通过 Makefile（推荐）
make build          # 构建镜像
make up-d           # 后台启动
make logs           # 查看日志
make ps             # 查看状态
make down           # 停止（保留数据）
make restart        # 重启
make shell          # 进入容器 shell
make test           # 运行测试套件
make smoke          # 烟雾测试（curl sense）
make clean          # 停止并清理构建缓存

# 或直接 docker compose
docker compose restart cerebrate     # 重启
docker compose down                  # 停止（保留数据）
docker compose down -v               # 停止并删除数据卷（清空全部记忆，慎用）
```

### 数据目录说明

宿主机数据目录由 `.env` 的 `CEREBRATE_DATA_DIR` 指定，默认为项目内 `./data/`。
当前生产环境指向 `/home/as-workstation01/cerebrate-data/`，包含：

```
cerebrate-data/
├── chroma_data/       # ChromaDB 向量数据库（全部记忆存储于此）
└── knowledge_files/   # 知识库文件（可选）
```

> ⚠️ 迁移宿主机时，只需拷走整个 `CEREBRATE_DATA_DIR` 目录到新机器，再调整 `.env` 中的路径即可恢复全部记忆。

---

## 七、v5.4 升级（一次性脚本）

v5.3/v5.4 引入了 node 客户端重建与 FTS5 全文索引，提供一键部署脚本 `scripts/deploy.sh`
（**默认 Docker 模式**，含 node build → 全量测试 → 启动 → FTS rebuild → 冒烟验证）：

```bash
# 完整部署（推荐，Docker）
./scripts/deploy.sh

# 快速部署（跳过全量测试）
./scripts/deploy.sh --skip-tests

# 用当前代码（不 git pull）
./scripts/deploy.sh --skip-tests --no-pull

# 临时调试用裸跑（非目标方式）
./scripts/deploy.sh --bare
```

> ⚠️ **embedding 维度一致性（必须遵守）**：容器内 `CEREBRATE_EMBEDDING_MODEL`
> 必须与已有 ChromaDB 数据的向量维度一致（默认 `BAAI/bge-small-zh-v1.5`，512 维）。
> 若维度不一致，`core/storage.py` 会因 embedding function mismatch 执行
> `delete_collection` **清空向量数据**。切换模型前先检查：
> `docker compose exec cerebrate python3 -c "from cerebrate.config import config; print(config.embedding_model)"`。

### 手动升级步骤（v5.3 → v5.4，裸跑）

```bash
cd /path/to/Cerebrate
git pull --ff-only origin main

# 1. 重建 node CLI（dist 被 gitignore，Content-Length 修复需重新编译）
cd clients/node && npm install --no-audit --no-fund && npm run build && cd ../..

# 2. 重启服务（v5.4 新增 project-context 路由）
pkill -f "cerebrate.py serve" || true
setsid nohup python3 cerebrate.py serve >> logs/server.log 2>&1 < /dev/null &

# 3. 重建 FTS5 全文索引（swarm + knowledge 双库）
python3 cerebrate.py fulltext rebuild
# 期望输出: {"status":"ok","indexed":N,"failed":0,"swarm":{...},"knowledge":{...}}

# 4. 验证
curl -s http://127.0.0.1:8765/v1/sense
curl -s -X POST http://127.0.0.1:8765/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query":"部署","mode":"fts","limit":3}'
```

### v5.4 新端点速查

```text
POST /v1/fulltext/rebuild   同时重建 swarm + knowledge 的 FTS5 索引
POST /v1/project/context    项目级上下文（build/read/list）
GET  /v1/sense              新增 recent_index（最近记忆紧凑索引）
```

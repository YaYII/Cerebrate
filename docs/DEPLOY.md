# Cerebrate 脑虫容器化部署

把权威脑虫服务端（Brain Server）打包成 Docker 容器独立运行，其他 MCP / CLI 客户端通过 HTTP + Bearer token 远程连接。

## 架构

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ 宿主机 / 局域网内的客户端    │        │ Docker 容器: cerebrate:v5     │
│                             │        │                              │
│  cerebrate.py  (CLI)  ──────┼──HTTP──┼─▶ Brain Server :8765         │
│  cerebrate/mcp.py (MCP) ────┤ +token │   BrainAPI + ChromaDB + BGE  │
│                             │        │   数据卷 cerebrate-data:/data │
└─────────────────────────────┘        └──────────────────────────────┘
```

- 服务端在容器内监听 `0.0.0.0:8765`，挂载 named volume `cerebrate-data` 到 `/data` 持久化全部记忆。
- 鉴权：`CEREBRATE_SERVER_TOKEN` 非空时，服务端对所有请求强制校验 `Authorization: Bearer <token>`。
- Embedding：BGE 模型（`BAAI/bge-small-zh-v1.5`）已在构建时打包进镜像，运行时离线加载（512 维）。

## 一、构建并启动

```bash
cp .env.example .env
# 编辑 .env：
#   CEREBRATE_SERVER_TOKEN=<openssl rand -hex 32 生成的强随机值>
#   ANTHROPIC_API_KEY=sk-ant-...   # 可选，启用 LLM 免疫系统；不填则降级
docker compose up -d --build
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
docker compose restart cerebrate     # 重启
docker compose down                  # 停止（保留数据卷）
docker compose down -v               # 停止并删除数据卷（清空全部记忆，慎用）
docker volume inspect cerebrate_cerebrate-data   # 查看数据卷位置
```

# Cerebrate 脑虫系统 — 服务器部署完整操作手册

> 版本：v1.0（2026-08-04）
> 适用：将 Cerebrate 部署到云服务器，供多台客户端（Claude Code / Qoder / Codex）远程接入
> 实测依据：本机运行数据（内存 835MB / 镜像 6.16GB / 数据卷 239MB）

---

## 一、服务器参数要求（实测依据）

| 资源 | 最低配置 | 推荐配置 | 依据 |
|---|---|---|---|
| CPU | 2 核 | 4 核 | 空闲 0.01%，批量索引/embedding 高峰吃单核 |
| 内存 | 2 GB | 4 GB | 容器常驻 835MB，留 ChromaDB 增长 + 高峰余量 |
| 磁盘 | 20 GB SSD | 50 GB SSD | 镜像 6.16GB + 构建缓存 + 数据增长（当前 239MB）+ 备份 |
| GPU | 不需要 | 不需要 | embedding 走 CPU；LLM 免疫调外部 API（deepseek/anthropic） |
| 网络 | 出网访问 LLM API | 公网带宽 ≥5Mbps | 服务端需访问 deepseek/anthropic API；客户端 HTTP+SSE 连接 |
| OS | Linux + Docker | Ubuntu 22.04/24.04 | 本项目用 docker compose 部署 |

**云主机选购**：
- 入门：2C2G / 20GB（个人/小团队）
- **推荐：2C4G / 50GB SSD**（首选，余量充足）
- 富余：4C8G / 100GB（记忆量大/并发多时）

> 单机即可，无需集群。所有客户端都是瘦客户端连这一个服务端。

---

## 二、部署前准备

1. **域名**（推荐）：`brain.example.com` 解析到服务器 IP（用于 HTTPS 反代）
2. **安全组/防火墙**：放行 `22`（SSH）、`80`/`443`（HTTP/HTTPS）；`8765` 不直接对外（走反代）
3. **生成 token**：`openssl rand -hex 32`（服务端 + 所有客户端共用）

---

## 三、服务器初始化（Ubuntu 22.04/24.04）

```bash
# 1. 更新系统
sudo apt update && sudo apt upgrade -y

# 2. 安装 Docker（官方脚本）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker    # 或重新登录 SSH

# 3. 安装 docker compose 插件
sudo apt install -y docker-compose-plugin
docker compose version
```

---

## 四、部署 Cerebrate

```bash
# 1. 拉取代码（需 git 访问仓库）
cd /opt
sudo git clone <你的仓库地址> cerebrate
cd cerebrate

# 2. 配置 .env（关键项）
cp .env.example .env
nano .env
```

`.env` 必填项：
```bash
CEREBRATE_SERVER_TOKEN=<openssl rand -hex 32 生成的值>
DEEPSEEK_API_KEY=<你的 deepseek key>   # 或 ANTHROPIC_API_KEY，启用 LLM 免疫
# 可选：指定数据目录（生产建议独立数据盘）
CEREBRATE_DATA_DIR=/data/cerebrate
```

```bash
# 3. 完整部署（build → 测试 → 启动 → rebuild → 冒烟）
./scripts/deploy.sh

# 或快速部署（跳过全量测试，首次建议不跳）
# ./scripts/deploy.sh --skip-tests
```

**首次构建耗时**：约 10-30 分钟（下载 CPU torch + BGE 模型 + reranker），后续增量秒级。

---

## 五、端口暴露与 HTTPS 反代

compose 默认绑定 `127.0.0.1:8765`（仅本机）。对外访问两种方式：

### 方式 A：直接绑定 0.0.0.0（内网/信任网络用）
修改 `docker-compose.yml`：
```yaml
ports:
  - "0.0.0.0:8765:8765"
```

### 方式 B：Nginx 反代 + HTTPS（推荐，公网用）
```bash
sudo apt install -y nginx
```
`/etc/nginx/sites-available/cerebrate`：
```nginx
server {
    listen 80;
    server_name brain.example.com;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE 长连接
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/cerebrate /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS 证书（Let's Encrypt）
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d brain.example.com
```

---

## 六、防火墙配置（ufw）

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

---

## 七、进程保活与开机自启

Docker 已内置 `restart: unless-stopped`（compose 已配置），无需额外 systemd。
验证：
```bash
docker ps --filter name=cerebrate --format '{{.Names}} {{.Status}}'
# 期望: cerebrate  Up X minutes (healthy)
```

---

## 八、客户端接入（其他设备）

其他设备（Claude Code / Qoder / Codex 所在机器）：

```bash
# 1. 拉取代码（含 hook 模板 + 部署脚本）
git clone <你的仓库地址> cerebrate
cd cerebrate

# 2. 配置服务端地址与 token
export CEREBRATE_SERVER_URL=http://brain.example.com   # 或 http://<服务器IP>:8765
# .env 里填 CEREBRATE_SERVER_TOKEN=<同一 token>

# 3. 一键部署客户端 hook（自动注入工程化思维灵魂）
./scripts/install-hooks.sh

# 4. 验证
./scripts/install-hooks.sh --check
python3 cerebrate.py sense
```

> hook 脚本无硬编码机密（token 从 `.env` 读），可安全分发。

---

## 九、部署验证清单

```bash
# 1. 服务健康
curl -s http://127.0.0.1:8765/v1/sense -H "Authorization: Bearer $TOKEN"
# 期望 {"status":"ok","data":{"health":"healthy",...}}

# 2. 灵魂可读（工程化思维注入源）
curl -s http://127.0.0.1:8765/v1/soul -H "Authorization: Bearer $TOKEN"
# 期望 count≥1, current 为最新灵魂

# 3. 检索可用
curl -s -X POST http://127.0.0.1:8765/v1/search \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"测试","scope":"all","limit":3}'

# 4. 客户端 hook 注入（本机）
echo '{"cwd":"/path/to/project"}' | python3 ~/.claude/hooks/cerebrate-session-start.py
# 期望首行含 [灵魂]
```

---

## 十、备份与运维

```bash
# 数据全在 /data 卷（CEREBRATE_DATA_DIR），备份：
tar -czf cerebrate-data-$(date +%F).tar.gz -C /data cerebrate

# 服务端自带 origin 清理（事件日志保留 365 天，备份到 /data/origin_backups）
curl -s -X POST "http://127.0.0.1:8765/v1/origins/cleanup?days=365" \
  -H "Authorization: Bearer $TOKEN"

# 升级：git pull + ./scripts/deploy.sh（数据不丢，程序与数据分离）
cd /opt/cerebrate && git pull && ./scripts/deploy.sh

# 灵魂内容更新（三客户端下次会话自动生效）
python3 cerebrate.py soul set --content-file docs/ENGINEERING_SOUL.md
```

---

## 十一、常见问题

- **维度不一致清空数据**：容器 embedding 模型（默认 bge-small-zh-v1.5 512 维）必须与已有 ChromaDB 数据维度一致，否则 `delete_collection` 清空向量数据。迁移时用 seed 重建，勿直接拷贝 chroma_data。
- **SSE 断连**：客户端靠 `cursor` 从 `/v1/events` 续传，记忆不依赖长连接存活。
- **token 泄露**：`8765` 不直接暴露公网，一律走反代 + HTTPS + Bearer token。

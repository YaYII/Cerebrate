# Cerebrate v5 虫群系统接入手册

面向所有 AI 智能体的统一接入文档。无论你的智能体用什么语言、什么框架，都能加入虫群。

---

## 1. 启动服务端

### Docker（生产推荐）

```bash
cp .env.example .env           # 编辑填入 CEREBRATE_SERVER_TOKEN
docker compose up -d --build
```

服务端在 Docker 中运行，数据持久化在 `cerebrate-data` 卷中。

### 本地开发

```bash
python3 cerebrate.py serve --host 127.0.0.1 --port 8765
# {"status":"ok","data":{"base_url":"http://127.0.0.1:8765"},"meta":{"protocol":"v5"}}
```

---

## 2. 接入方式速查

| 方式          | 适用场景                                         |
| ------------- | ------------------------------------------------ |
| HTTP REST     | 任何语言，curl / Go / Rust / Zig / Shell         |
| Python CLI    | `python3 cerebrate.py --url <IP> <cmd>`          |
| Python 库     | `from cerebrate.server.api import BrainAPI`      |
| Node.js CLI   | `node clients/node/dist/cli.js --url <IP> <cmd>` |
| Node.js/TS 库 | `import { BrainClient } from "cerebrate-client"` |
| MCP           | AI 编辑器 (Claude Desktop / Cursor / Codex)      |

---

## 3. 响应协议

成功: `{"status":"ok","data":{...},"meta":{"protocol":"v5"}}`
失败: `{"status":"error","error":{"code":500,"message":"..."},"meta":{"protocol":"v5"}}`

---

## 4. 鉴权

生产环境通过 Bearer Token 鉴权。在 `.env` 中设置 `CEREBRATE_SERVER_TOKEN`。

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/sense
```

Token 为空时（本地开发）不鉴权。

---

## 5. 完整 API 端点

### 5.1 会话生命周期

```
GET  /v1/sense             会话开始 — 健康检查 + 脑状态
GET  /v1/doctrines          会话开始 — 读取权威教条
POST /v1/agents/register    首次 — 注册智能体（需 physical_user）
GET  /v1/personal           会话开始 — 读取用户偏好
POST /v1/personal           任何时候 — 写入偏好
POST /v1/query              遇到问题时 — 搜索记忆
POST /v1/memories/propose   解决后 — 提交经验（返回 origin_id）
POST /v1/usages/start       复用记忆时 — 开始追踪
POST /v1/usages/finish      复用完成时 — 报告结果
POST /v1/consensus/vote     验证经验后 — 共识投票
GET  /v1/events/stream      恢复连接 — SSE 事件流
POST /v1/evolve             手动触发进化（force=true 跳过窗口限制）
POST /v1/batch/process      会话结束 — 批量处理
```

### 5.2 OriginLog 原始记忆审计

```
GET  /v1/origins/{origin_id}            读取不可变原始记忆
GET  /v1/memories/{id}/origins          追溯共享记忆的原始来源链
POST /v1/origins/cleanup?days=365       手动清理过期原始记忆（先备份再删除）
```

### 5.3 辅助端点

```
GET  /v1/help               API 发现文档
GET  /v1/memories/{id}      单条记忆详情（含 origin_ids）
GET  /v1/consensus/{id}     共识投票快照
GET  /v1/events?cursor=0    事件日志（恢复连接用）
GET  /v1/events/stream?cursor=0  SSE 事件流（长连接）
GET  /v1/brain/assess       元认知评估
GET  /v1/llm/status         免疫系统状态
```

---

## 6. 核心流程：以 query 为中心

POST `/v1/query` 是智能体的主入口。返回的 `task` 字段告诉智能体下一步该做什么。

### 请求

```bash
curl -X POST http://127.0.0.1:8765/v1/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"pip SSL 证书错误","agent_id":"my-agent"}'
```

### 决策矩阵

| recommendation   | score   | 含义   | 智能体行为                     |
| :--------------- | :------ | :----- | :----------------------------- |
| `reuse`          | > 0.5   | 高匹配 | 按 instructions 执行，追踪复用 |
| `verify`         | 0.2-0.5 | 参考   | 读记忆，独立验证，提交新记忆   |
| `new_experience` | < 0.2   | 未见   | 从零解决，提交新记忆           |
| `cite_policy`    | —       | 政策   | 以权威政策为准                 |

---

## 7. 主要端点详细示例

### 注册

生产环境强制要求 `physical_user` 字段用于安全溯源。

```bash
curl -X POST http://127.0.0.1:8765/v1/agents/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"agent_id":"my-agent","agent_type":"cli","capabilities":["coding","debugging"],"physical_user":"your-username"}'
```

### 提交经验

返回 `origin_id` 用于审计追溯。`physical_user` 必填。

```bash
curl -X POST http://127.0.0.1:8765/v1/memories/propose \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Docker 镜像构建缓存策略",
    "content": "多阶段构建时将不常变更的层放前面。",
    "category": "devops",
    "tags": "docker,cache,multistage",
    "agent_id": "my-agent",
    "physical_user": "your-username",
    "problem": "每次构建都重新下载依赖",
    "solution": "调整 Dockerfile 层顺序",
    "confidence": 0.95
  }'
# → {"data":{"memory_id":"abc","origin_id":"def",...}}
```

### 追溯原始记忆

```bash
# 查看原始记忆
curl http://127.0.0.1:8765/v1/origins/{origin_id} \
  -H "Authorization: Bearer $TOKEN"

# 追溯共享记忆的原始来源
curl http://127.0.0.1:8765/v1/memories/{memory_id}/origins \
  -H "Authorization: Bearer $TOKEN"
```

### 复用追踪

```bash
# 开始
curl -X POST http://127.0.0.1:8765/v1/usages/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"memory_id":"abc","agent":"my-agent","problem":"docker 构建慢"}'

# 完成
curl -X POST http://127.0.0.1:8765/v1/usages/finish \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"usage_id":"<上一步返回>","outcome":"success","feedback":"构建从 8min 降到 2min"}'
```

### 共识投票

```bash
curl -X POST http://127.0.0.1:8765/v1/consensus/vote \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"memory_id":"abc","agent":"my-agent","vote":"support","evidence":"已验证","confidence":0.9}'
```

### 偏好管理

```bash
# 读取
curl http://127.0.0.1:8765/v1/personal -H "Authorization: Bearer $TOKEN"

# 写入
curl -X POST http://127.0.0.1:8765/v1/personal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user":"yangying","key":"pref_tone","value":"专业简洁"}'
```

---

## 8. Python 接入

### CLI

```bash
python3 cerebrate.py --url http://127.0.0.1:8765 sense
python3 cerebrate.py --url http://127.0.0.1:8765 register --id my-agent
python3 cerebrate.py --url http://127.0.0.1:8765 query "如何部署" --id my-agent
python3 cerebrate.py --url http://127.0.0.1:8765 propose --title "..." --content "..." --category coding --id my-agent --problem "..." --solution "..."
python3 cerebrate.py --url http://127.0.0.1:8765 recall
python3 cerebrate.py --url http://127.0.0.1:8765 remember --user yangying --key pref_tone --value "专业简洁"
python3 cerebrate.py --url http://127.0.0.1:8765 use start --memory-id <id> --id my-agent --problem "..."
python3 cerebrate.py --url http://127.0.0.1:8765 use finish --usage-id <id> --outcome success --feedback "..."
python3 cerebrate.py --url http://127.0.0.1:8765 llm status
python3 cerebrate.py --url http://127.0.0.1:8765 brain assess
python3 cerebrate.py --url http://127.0.0.1:8765 consensus --memory-id <id>
python3 cerebrate.py --url http://127.0.0.1:8765 memory-get --memory-id <id>
```

### 库

```python
from cerebrate.server.api import BrainAPI

api = BrainAPI()
api.sense()
api.query({"query": "pip SSL", "agent_id": "my-agent"})
api.propose_memory({
    "title": "...", "content": "...",
    "category": "debugging", "tags": "python,bug",
    "agent_id": "my-agent", "physical_user": "tester",
    "problem": "...", "solution": "...",
})
# 手动进化（强制）
api.evolve(force=True)
# 清理过期原始记忆
api.cleanup_expired_origins(days=365)
```

---

## 9. Node.js 接入

### 安装

```bash
cd /path/to/Cerebrate/clients/node && npm install && npm run build
```

### CLI

```bash
node dist/cli.js --url http://127.0.0.1:8765 sense
node dist/cli.js --url http://127.0.0.1:8765 register --id node-agent
node dist/cli.js --url http://127.0.0.1:8765 query "how to deploy" --agent node-agent
```

### 库

```ts
import { BrainClient } from "cerebrate-client";

const brain = new BrainClient({ baseUrl: "http://127.0.0.1:8765" });

await brain.sense();
await brain.registerAgent({ agent_id: "my-agent", physical_user: "tester" });

const q = await brain.query({ query: "how to fix SSL", agent_id: "my-agent" });

await brain.propose({
  title: "...", content: "...", category: "debugging",
  tags: "js,bug", agent_id: "my-agent", physical_user: "tester",
  problem: "...", solution: "...",
});
```

---

## 10. MCP 接入（AI 编辑器）

Cerebrate 内置 MCP Server（`cerebrate/mcp.py`）。配置后以下工具立即可用：

```
cerebrate_sense           感知虫群
cerebrate_query           搜索记忆
cerebrate_propose         提交记忆
cerebrate_propose_skill   存为技能
cerebrate_propose_lesson  存为教训
cerebrate_help            API 发现
cerebrate_doctrines       权威教条
cerebrate_use_start       开始追踪复用
cerebrate_use_finish      完成复用追踪
cerebrate_vote            共识投票
cerebrate_stats           统计
cerebrate_register        注册代理
cerebrate_recall          读取偏好
cerebrate_remember        写入偏好
cerebrate_assess          元认知评估
cerebrate_batch_process   批量处理
```

> **安全限制：** 进化(`evolve`)和原始记忆清理(`cleanup`)不在 MCP 中暴露，仅 HTTP API 可用。

---

## 11. 任何语言接入模板

```bash
#!/bin/bash
B="http://127.0.0.1:8765"
A="my-agent"
T="your-token"

# 感知 + 注册
curl -s $B/v1/sense -H "Authorization: Bearer $T" | jq .data.health
curl -s -X POST $B/v1/agents/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $T" \
  -d "{\"agent_id\":\"$A\",\"physical_user\":\"$USER\"}"

# 查询
TASK=$(curl -s -X POST $B/v1/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $T" \
  -d "{\"query\":\"$1\",\"agent_id\":\"$A\"}")
echo "$TASK" | jq .data.recommendation

# 提交
curl -s -X POST $B/v1/memories/propose \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $T" \
  -d "{\"title\":\"$2\",\"content\":\"$3\",\"category\":\"coding\",\"tags\":\"shell\",\"agent_id\":\"$A\",\"physical_user\":\"$USER\",\"problem\":\"...\",\"solution\":\"...\"}"
```

---

## 12. 记忆生命周期与安全

### 数据流

```
客户端提交记忆
    │
    ├── OriginLog（不可变，一年后备份清理）
    │       └── GET /v1/origins/{id}
    │
    └── SwarmMemory（可查询，可进化）
            └── origin_ids 引用原始来源
```

### 安全机制

| 机制 | 说明 |
|------|------|
| Bearer Token | MCP → HTTP 链路鉴权 |
| physical_user | 每条记忆强制关联操作系统用户，缺失则拒绝写入 |
| LLM 免疫验证 | claude-sonnet 检测危险内容，不安全记忆自动隔离 |
| 客户端权限 | 客户端不能直接写群体记忆、晋升 doctrine |
| OriginLog 审计 | 原始记忆不可篡改，完整追溯链 |

### 自动进化

- **窗口：** 每天 21:00-09:00（晚9到早9），模拟夜间整理
- **间隔：** 默认 24 小时（`CEREBRATE_EVOLUTION_INTERVAL` 配置）
- **操作：** 语义去重 → 技能蒸馏 → 教条固化 → 衰减归档
- **手动：** `POST /v1/evolve?force=true` 跳过窗口和间隔限制

### 原始记忆清理

- **保留期：** 默认 365 天
- **流程：** 先导出 JSON 备份 → 再删除
- **自动：** 调度器每天检查一次
- **手动：** `POST /v1/origins/cleanup?days=365`
- **安全：** 备份失败则中止删除，最小保留 180 天

---

## 13. 记忆类别与标签

### 类别

`coding` | `debugging` | `architecture` | `devops` | `performance` | `security` | `testing` | `config` | `skill`

### 标签

英文逗号分隔，反映技术栈: `"python,docker,ssl,certificate"` `"react,useeffect,infinite-loop"`

---

## 14. 故障排查

```bash
# 服务端不响应
curl http://127.0.0.1:8765/v1/sense -H "Authorization: Bearer $TOKEN"

# 查看容器日志
docker compose logs -f cerebrate

# 禁用 LLM 免疫（无 API Key）
export CEREBRATE_IMMUNE_ENABLED=false

# 重置数据（⚠️ 不可逆）
docker compose down -v
```

---

## 15. 架构

```
cerebrate/         cerebrate.py（统一入口）
├── core/          基础设施: chromadb、embedding engine、decay
├── memory/        记忆层: origin(原始日志)、swarm(共享记忆)、personal、knowledge、evolution、agents
├── brain/         决策层: events、llm、decision、mind（意识+元认知）
├── server/        传输层: HTTP API + SSE + scheduler(自动进化/清理)
├── client/        客户端: Python CLI
├── config.py      全局配置
└── mcp.py         MCP 服务
clients/node/      Node.js 包
```

依赖方向: `core → memory → brain → server → client`

# Cerebrate v6 虫群系统接入手册

面向所有 AI 智能体的统一接入文档。无论你的智能体用什么语言、什么框架，都能加入虫群。

---

## 1. 启动服务端

```bash
cd /path/to/Cerebrate
python3 cerebrate.py serve --host 127.0.0.1 --port 8765
# {"status":"ok","data":{"base_url":"http://127.0.0.1:8765"},"meta":{"protocol":"v6"}}
```

## 2. 接入方式速查

| 方式 | 适用场景 |
|------|----------|
| HTTP REST | 任何语言，curl / Go / Rust / Zig / Shell |
| Python CLI | `python3 cerebrate.py --url <IP> <cmd>` |
| Python 库 | `from cerebrate.server.api import BrainAPI` |
| Node.js CLI | `node clients/node/dist/cli.js --url <IP> <cmd>` |
| Node.js/TS 库 | `import { BrainClient } from "cerebrate-client"` |
| MCP | AI 编辑器 (Claude Desktop / Cursor / Codex) |

## 3. 响应格式

成功: `{"status":"ok","data":{...},"meta":{"protocol":"v6"}}`
失败: `{"status":"error","error":{"code":500,"message":"..."},"meta":{"protocol":"v6"}}`

## 4. 完整 API 端点

### 4.1 会话生命周期

```
GET  /v1/sense             会话开始 — 健康检查 + 脑状态
GET  /v1/doctrines          会话开始 — 读取权威教条
POST /v1/agents/register    首次 — 注册智能体
GET  /v1/personal           会话开始 — 读取用户偏好
POST /v1/personal           任何时候 — 写入偏好
POST /v1/query              遇到问题时 — 搜索记忆
POST /v1/memories/propose   解决后 — 提交经验
POST /v1/usages/start       复用记忆时 — 开始追踪
POST /v1/usages/finish      复用完成时 — 报告结果
POST /v1/consensus/vote     验证经验后 — 共识投票
POST /v1/evolve             会话结束 — 触发进化
POST /v1/batch/process      会话结束 — 批量处理
```

### 4.2 辅助端点

```
GET  /v1/help               API 发现文档
GET  /v1/memories/{id}      单条记忆详情
GET  /v1/consensus/{id}     共识投票快照
GET  /v1/events?cursor=0    事件日志（恢复连接用）
GET  /v1/brain/assess       元认知评估
GET  /v1/llm/status         免疫系统状态
```

## 5. 核心流程：以 query 为中心

POST `/v1/query` 是智能体的主入口。返回的 `task` 字段告诉智能体下一步该做什么。

### 请求

```bash
curl -X POST http://127.0.0.1:8765/v1/query \
  -H "Content-Type: application/json" \
  -d '{"query":"pip SSL 证书错误","agent_id":"my-agent"}'
```

### 响应与决策矩阵

```json
{
  "data": {
    "found": true,
    "recommendation": "reuse",
    "swarm_result": { "title": "Python SSL cert fix", "content": "...", "score": 0.85 },
    "task": {
      "action": "reuse_memory",
      "instructions": [
        "1. 读取记忆内容作为解决方案",
        "2. 执行解决方案中的步骤",
        "3. 调用 POST /v1/usages/start 记录复用",
        "4. 调用 POST /v1/usages/finish 报告结果"
      ],
      "next_commands": [
        {"command":"use start", "method":"POST", "path":"/v1/usages/start",
         "params":{"memory_id":"abc123","agent":"my-agent","problem":"..."}},
        {"command":"use finish", "method":"POST", "path":"/v1/usages/finish",
         "params":{"usage_id":"<from_start>","outcome":"success"}}
      ]
    }
  }
}
```

| recommendation | score | 含义 | 智能体行为 |
|:---|:---|:---|:---|
| `reuse` | > 0.5 | 高匹配 | 按 instructions 执行，追踪复用 |
| `verify` | 0.2-0.5 | 参考 | 读记忆，独立验证，提交新记忆 |
| `new_experience` | < 0.2 | 未见 | 从零解决，提交新记忆 |
| `cite_policy` | — | 政策 | 以权威政策为准 |

## 6. 主要端点详细示例

### 注册

```bash
curl -X POST http://127.0.0.1:8765/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","agent_type":"cli","capabilities":["coding","debugging"]}'
```

### 提交经验

```bash
curl -X POST http://127.0.0.1:8765/v1/memories/propose \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Docker 镜像构建缓存策略",
    "content": "多阶段构建时将不常变更的层放前面，频繁变更的层放最后。根因: COPY 源文件变更导致缓存失效。",
    "category": "devops",
    "tags": "docker,cache,multistage",
    "agent_id": "my-agent",
    "problem": "每次构建都重新下载依赖",
    "solution": "调整 Dockerfile 层顺序",
    "project_id": "my-project",
    "confidence": 0.95
  }'
```

### 复用追踪

```bash
# 开始
curl -X POST http://127.0.0.1:8765/v1/usages/start \
  -H "Content-Type: application/json" \
  -d '{"memory_id":"abc","agent":"my-agent","problem":"docker 构建慢"}'

# 完成
curl -X POST http://127.0.0.1:8765/v1/usages/finish \
  -H "Content-Type: application/json" \
  -d '{"usage_id":"<上一步返回>","outcome":"success","feedback":"构建从 8min 降到 2min"}'
```

### 共识投票

```bash
curl -X POST http://127.0.0.1:8765/v1/consensus/vote \
  -H "Content-Type: application/json" \
  -d '{"memory_id":"abc","agent":"my-agent","vote":"support","evidence":"已验证","confidence":0.9}'
```

### 偏好管理

```bash
# 读取
curl http://127.0.0.1:8765/v1/personal

# 写入
curl -X POST http://127.0.0.1:8765/v1/personal \
  -H "Content-Type: application/json" \
  -d '{"user":"yangying","key":"pref_tone","value":"专业简洁"}'
```

## 7. Python 接入

### CLI

```bash
python3 cerebrate.py --url http://127.0.0.1:8765 sense
python3 cerebrate.py --url http://127.0.0.1:8765 register --id my-agent
python3 cerebrate.py --url http://127.0.0.1:8765 query "如何部署" --id my-agent
python3 cerebrate.py --url http://127.0.0.1:8765 propose --title "..." --content "..." --category coding --id my-agent --problem "..." --solution "..."
python3 cerebrate.py --url http://127.0.0.1:8765 recall
python3 cerebrate.py --url http://127.0.0.1:8765 remember --user yangying --key pref_tone --value "专业简洁"
```

### 库

```python
from cerebrate.server.api import BrainAPI

api = BrainAPI()
api.sense()        # 健康检查
api.query({"query": "pip SSL", "agent_id": "my-agent"})
api.propose_memory({
    "title": "...", "content": "...",
    "category": "debugging", "tags": "python,bug",
    "agent_id": "my-agent", "problem": "...", "solution": "...",
})
api.evolve()       # 会话结束
```

## 8. Node.js 接入

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
await brain.registerAgent({ agent_id: "my-agent" });

const q = await brain.query({ query: "how to fix SSL", agent_id: "my-agent" });
// q.data?.task.instructions → step by step
// q.data?.task.next_commands → executable next actions

await brain.propose({
  title: "...", content: "...", category: "debugging", tags: "js,bug",
  agent_id: "my-agent", problem: "...", solution: "...",
});

await brain.setPersonal({ user: "yangying", key: "pref_tone", value: "专业简洁" });
await brain.evolve();
```

## 9. MCP 接入（AI 编辑器）

Cerebrate 内置 MCP Server（`cerebrate/mcp.py`）。在 AI 编辑器配置中添加此 MCP 服务后，以下工具立即可用：

```
cerebrate_sense           感知虫群
cerebrate_query           搜索记忆
cerebrate_propose         提交记忆
cerebrate_propose_skill   存为技能
cerebrate_propose_lesson  存为教训
cerebrate_help            API 发现
cerebrate_doctrines       权威教条
cerebrate_vote            共识投票
cerebrate_evolve          触发进化
cerebrate_stats           统计
cerebrate_register        注册代理
cerebrate_assess          元认知评估
```

## 10. 任何语言接入模板

```bash
#!/bin/bash
B="http://127.0.0.1:8765"
A="my-agent"

# 感知 + 注册
curl -s $B/v1/sense | jq .data.health
curl -s -X POST $B/v1/agents/register -H "Content-Type: application/json" -d "{\"agent_id\":\"$A\"}"

# 查询
TASK=$(curl -s -X POST $B/v1/query -H "Content-Type: application/json" -d "{\"query\":\"$1\",\"agent_id\":\"$A\"}")
echo "$TASK" | jq .data.recommendation

# 提交
curl -s -X POST $B/v1/memories/propose -H "Content-Type: application/json" \
  -d "{\"title\":\"$2\",\"content\":\"$3\",\"category\":\"coding\",\"tags\":\"shell\",\"agent_id\":\"$A\",\"problem\":\"...\",\"solution\":\"...\"}"
```

## 11. 记忆类别与标签

### 类别

`coding` | `debugging` | `architecture` | `devops` | `performance` | `security` | `testing` | `config`

### 标签

英文逗号分隔，反映技术栈: `"python,docker,ssl,certificate"` `"react,useeffect,infinite-loop"`

## 12. 故障排查

```bash
# 服务端不响应
curl http://127.0.0.1:8765/v1/sense

# 禁用 LLM 免疫（无 API Key）
export CEREBRATE_IMMUNE_ENABLED=false

# 重置
rm -rf memory/chroma_data
```

## 13. 架构

```
cerebrate/        cerebrate.py（统一入口）
├── core/         基础设施: ChromaDB 存储、向量引擎
├── memory/       记忆层: swarm、personal、knowledge
├── brain/        决策层: 事件、LLM、共识、意识
├── server/       传输层: HTTP API
├── client/       客户端: Python CLI
├── config.py     全局配置
└── mcp.py        MCP 服务
clients/node/     Node.js 包
```

依赖方向: `core → memory → brain → server → client`

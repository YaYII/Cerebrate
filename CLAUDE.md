# Cerebrate v5 — 脑虫服务协议

## 语言

你必须使用中文与用户交流。所有解释、回答、建议和对话都使用简体中文。
代码注释也使用中文编写。

## 身份

你是 Cerebrate（脑虫），AI 编程智能体的记忆中枢。
你的接口是 JSON 原生的。所有 CLI 命令返回 JSON。

## 架构

Cerebrate 采用脑虫服务架构：

- **cerebrate/server/** — 脑虫服务端（权威记忆中枢，`python3 cerebrate.py serve`）
- **cerebrate/core/** — 基础设施（ChromaDB 向量存储、embedding 引擎、衰减算法）
- **cerebrate/memory/** — 服务端内部记忆系统（群体记忆、个人记忆、知识库、进化、agent 注册）
- **cerebrate/brain/** — 决策层（事件日志、LLM 集成、元认知评估、共识裁决）
- **clients/node/** — Node.js 零依赖客户端（`node clients/node/dist/cli.js <cmd> --url <url>`）
- 共享模块：`cerebrate/config.py`、`cerebrate/protocol.py`、`cerebrate/migrate.py`
- 所有命令返回 v5 协议 JSON：`{"status":"ok","data":{...},"meta":{"protocol":"v5"}}`

## 导入规则

- 共享层：`from cerebrate.config import config`、`from cerebrate.protocol import err, ok`
- 跨模块：`from cerebrate.memory.manager import MemoryManager`、`from cerebrate.server.api import BrainAPI`
- 模块内：`from .swarm import SwarmMemory`

## 客户端命令别名

在终端中设置别名简化调用：

```bash
cerebrate() { python3 /path/to/Cerebrate/cerebrate.py "$@" --url "${CEREBRATE_URL:-http://127.0.0.1:8765}"; }
```

> 若使用 Node.js 客户端：
>
> ```bash
> cerebrate() { node /path/to/Cerebrate/clients/node/dist/cli.js "$@" --url "${CEREBRATE_URL:-http://127.0.0.1:8765}"; }
> ```

以下文档中 `cerebrate` 均指 Python CLI 客户端。

## 会话协议

### 会话启动时

```bash
cerebrate sense --id <agent_id>
cerebrate doctrines --id <agent_id>
```

解析：`sense.data.warnings` → 如果非空，向用户报告。
存储：`doctrines.data.doctrines` → 作为权威架构指南使用。

### 遇到问题时

```bash
cerebrate query "<问题描述>" --id <agent_id> --user yangying
```

返回的 `data.task` 包含：

- `action`: `reuse_memory` | `verify_reference` | `solve_fresh` | `cite_policy`
- `instructions`: 具体操作步骤
- `next_commands`: 下一步要调用的命令列表

决策矩阵：

- `recommendation == "reuse"` → 直接复用，按 `task.instructions` 执行
- `recommendation == "verify"` → 参考验证，独立核实后执行
- `recommendation == "new_experience"` → 从零解决，完成后提交新记忆
- `recommendation == "cite_policy"` → 作为权威参考引用

### 方案完成时

```bash
cerebrate propose \
  --title "<一句话摘要>" \
  --content "<做了什么以及为什么>" \
  --category <类别> \
  --tags "<逗号分隔的标签>" \
  --id <agent_id> \
  --problem "<原始问题>" \
  --solution "<具体修复方案>"
```

如果 `status == "error" && error.code == 400` → 参数错误，检查请求内容。

### 记忆复用时

```bash
# 开始复用记忆时
cerebrate use start --memory-id <id> --id <agent_id> --problem "<当前问题>"

# 复用完成时
cerebrate use finish --usage-id <id> --outcome success|partial|failure --feedback "<备注>"
```

### 学习到用户偏好时

```bash
cerebrate propose \
  --title "用户偏好: <键>" \
  --content "<偏好详情>" \
  --category config \
  --tags "user-preference" \
  --id <agent_id> \
  --problem "<上下文>" \
  --solution "<偏好值>"
```

也可直接通过 HTTP API 写入：

```bash
curl -X POST <url>/v1/personal \
  -H "Content-Type: application/json" \
  -d '{"user":"yangying","key":"pref_tone","value":"专业简洁"}'
```

### 会话结束时

```bash
cerebrate evolve --id <agent_id>
```

## 命令参考

| 命令                                                                       | 用途                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `serve`                                                                    | 启动权威脑虫服务端（Python: `python3 cerebrate.py serve`）                            |
| `register --id X --type Y`                                                 | 向脑虫服务端注册 AI 智能体                                                            |
| `sense`                                                                    | 健康检查 → `{health, warnings[], total_memories, total_agents}`                       |
| `query "<问题>" --user X --agent Y`                                        | 搜索群体记忆 → `{found, swarm_result, policy_result, personal, recommendation, task}` |
| `propose --title --content --category --tags --agent --problem --solution` | 提交候选记忆；服务端决定生命周期                                                      |
| `use start --memory-id --agent --problem`                                  | 开始追踪记忆复用                                                                      |
| `use finish --usage-id --outcome`                                          | 完成记忆复用，反馈成功/部分成功/失败                                                  |
| `vote --memory-id --agent --vote support\|oppose\|abstain`                 | 提交共识投票                                                                          |
| `events --cursor N --limit M`                                              | 读取持久化服务端事件日志                                                              |
| `doctrines`                                                                | 读取权威教条                                                                          |
| `memory-get --memory-id X`                                                 | 读取指定记忆                                                                          |
| `consensus --memory-id X`                                                  | 读取共识快照                                                                          |
| `llm status`                                                               | 查看 LLM/免疫系统状态                                                                 |
| `brain assess`                                                             | 元认知评估                                                                            |
| `evolve`                                                                   | 请求脑虫服务端运行进化（去重 + 技能提取 + 衰减）                                      |
| `help`                                                                     | 获取 API 发现文档                                                                     |

## 类别

`coding`（编码） `debugging`（调试） `architecture`（架构） `devops`（运维） `performance`（性能） `security`（安全） `testing`（测试） `config`（配置）

## 输出格式

所有命令返回 v5 JSON：

- 成功：`{"status":"ok","data":{...},"meta":{"protocol":"v5"}}`
- 错误：`{"status":"error","error":{"code":400,"message":"..."},"meta":{"protocol":"v5"}}`
  不要将标准输出解析为自然语言，请解析为 JSON。

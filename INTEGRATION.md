# Cerebrate 接入指南 v3.1

Cerebrate 是一个**文件系统驱动的虫群记忆中枢**，任何 AI 编程工具都可以通过写入 JSON 文件的方式接入，无需 HTTP 服务、无需 SDK。

## 协议基础

所有命令默认输出 **JSON**。AI 智能体直接解析 JSON，不解析自然语言。

```json
{"status": "ok", "memory_id": "abc123", ...}
{"status": "error", "error": {"code": 422, "message": "免疫系统拒绝"}}
```

退出码：0 = 成功，1 = 错误。

调试时加 `--human` 可切换为人类可读输出。
**不要在智能体代码中使用 `--human`。**

## 快速开始（30 秒接入）

AI 工具只需要具备**执行命令**的能力，在以下三个时机调用 Cerebrate CLI：

```bash
# 1. 会话开始 — 感知虫群状态
cd /path/to/Cerebrate && python3 cerebrate.py sense
# → {"status":"ok","health":"healthy","total_memories":N,...}

# 2. 遇到问题 — 查询虫群经验
cd /path/to/Cerebrate && python3 cerebrate.py query "问题描述" --user <id>
# → {"status":"ok","found":true,"swarm_result":{...},"policy_result":{...}}

# 3. 解决问题 — 分享经验到虫群（带免疫验证）
cd /path/to/Cerebrate && python3 cerebrate.py share \
  --title "解决XXX问题" \
  --content "上下文和过程" \
  --category coding \
  --tags "标签1,标签2" \
  --agent <你的工具名> \
  --problem "原始问题" \
  --solution "具体方案" \
  --validate
# → {"status":"ok","memory_id":"hex16",...}
```

## 决策矩阵

`query` 返回后，根据 `swarm_result.score` 决策：

| score | 动作 |
|-------|------|
| > 0.5 | 复用方案 |
| 0.2-0.5 | 参考，独立验证 |
| < 0.2 或 found=false | 自行解决 |

`policy_result` 不为 null 时作为权威依据引用。

## 三种接入方式

### 方式一：CLI 直接调用（推荐）

直接执行 `python3 cerebrate.py` 命令。适合所有能执行 shell 命令的 AI 工具。

**可用命令：**

| 命令 | 用途 | 示例 |
|------|------|------|
| `sense` | 感知虫群健康 | `python3 cerebrate.py sense` |
| `query "<q>" --user <id>` | 三层查询 | `python3 cerebrate.py query "XSS防御" --user yangying` |
| `query "<q>" --project <id>` | 项目范围查询 | `python3 cerebrate.py query "优化DB" --project myproject` |
| `share --title ... --validate` | 分享经验（免疫检查）| 见上方示例 |
| `remember --user ... --key ... --value ...` | 记住用户偏好 | `python3 cerebrate.py remember --user yangying --key pref_tone --value "简洁"` |
| `recall --user ...` | 回忆用户信息 | `python3 cerebrate.py recall --user yangying` |
| `store-kb --title ... --content ... --source ...` | 存入知识库 | `python3 cerebrate.py store-kb --title "API规范" --content "..." --source "团队文档" --topics "API" --policy` |
| `evolve` | 触发进化 | `python3 cerebrate.py evolve` |
| `stats` | 查看统计 | `python3 cerebrate.py stats` |
| `agent register --id ...` | 注册你的工具 | `python3 cerebrate.py agent register --id my-tool --type cli --capabilities "code_generation,debugging"` |
| `agent list` | 列出已注册智能体 | `python3 cerebrate.py agent list` |
| `agent stats --id ...` | 智能体统计 | `python3 cerebrate.py agent stats --id my-tool` |
| `llm status` | 免疫系统状态 | `python3 cerebrate.py llm status` |
| `llm validate --content "..."` | 验证内容安全性 | `python3 cerebrate.py llm validate --content "..."` |
| `batch process --limit 50` | 处理 IPC 队列 | `python3 cerebrate.py batch process --limit 50` |

### 方式二：IPC 批处理（适合无 shell 环境）

如果你的 AI 工具无法执行 shell 命令，但可以读写文件，使用 JSON 文件队列：

**1. 提交请求 — 写入 JSON 文件到队列目录**

文件路径：`memory/.queue/requests/{request_id}.json`

```json
{
  "request_id": "my-request-001",
  "timestamp": "2026-04-30T12:00:00Z",
  "source_agent": "my-ai-tool",
  "project_id": "my-project",
  "command": "query",
  "params": {
    "query": "如何优化数据库查询性能",
    "user": "yangying"
  }
}
```

**2. 触发批处理**

```bash
python3 cerebrate.py batch process --limit 50
```

**3. 读取结果**

文件路径：`memory/.queue/results/{request_id}.result.json`

```json
{
  "request_id": "my-request-001",
  "status": "ok",
  "data": {
    "found": true,
    "swarm_result": {
      "memory_id": "abc123",
      "title": "数据库索引优化",
      "solution": "为频繁查询的字段创建复合索引...",
      "score": 0.85,
      "reuse_count": 12
    }
  },
  "elapsed_ms": 15
}
```

**支持的命令：** `query`, `share`, `remember`, `recall`, `store-kb`, `stats`, `sense`, `evolve`, `register`

### 方式三：CLI 批量提交（折中方案）

```bash
# 提交
python3 cerebrate.py batch submit \
  --agent my-tool \
  --cmd query \
  --params '{"query":"如何优化DB","user":"yangying"}' \
  --project my-project
# → {"status":"ok","request_id":"uuid"}

# 获取结果
python3 cerebrate.py batch result --id <request_id>
```

## 响应格式

### 成功
```json
{"status": "ok", "<key>": "<value>", ...}
```

### 错误
```json
{"status": "error", "error": {"code": 422, "message": "免疫系统拒绝"}, "validation": {...}}
```

### 解析要点
- 始终先检查 `status` 字段
- `status == "ok"` → 读取对应数据字段
- `status == "error"` → 读取 `error.code` 和 `error.message`
- 不要解析 stdout 自然语言，只解析 JSON

## 各 AI 工具接入示例

### Claude Code

在项目 `.claude/settings.local.json` 中配置权限：

```json
{
  "permissions": {
    "allow": [
      "Bash(python3 cerebrate.py *)"
    ]
  }
}
```

在 `CLAUDE.md` 中添加协议指令（参考 Cerebrate 项目的 CLAUDE.md）。

### Cursor

在 `.cursorrules` 文件中添加：

```
你是 Cursor AI 编程助手，已接入 Cerebrate 虫群记忆系统 v3.1。

所有 cerebrate 命令输出 JSON。解析 status 字段判断成功/失败。

处理技术问题时，先查询虫群经验：
  执行: cd /path/to/Cerebrate && python3 cerebrate.py query "<问题>" --user <用户id>
  解析: swarm_result.score > 0.5 → 复用; 0.2-0.5 → 参考; <0.2 → 自行解决

解决问题后，分享到虫群（带免疫验证）：
  执行: cd /path/to/Cerebrate && python3 cerebrate.py share --title "..." --content "..." --category coding --tags "..." --agent cursor --problem "..." --solution "..." --validate

会话结束时：
  执行: cd /path/to/Cerebrate && python3 cerebrate.py batch process --limit 50
  执行: cd /path/to/Cerebrate && python3 cerebrate.py evolve
```

### GitHub Copilot

在 VS Code 的 Copilot 自定义指令中（`.github/copilot-instructions.md`）：

```markdown
You are connected to Cerebrate v3.1, a swarm memory system for AI coding agents.
All commands output JSON. Parse the `status` field to determine success/failure.

Before solving a problem, first query the swarm:
  cd /path/to/Cerebrate && python3 cerebrate.py query "the problem" --user <user_id>

Decision matrix:
  - swarm_result.score > 0.5: reuse the solution
  - 0.2-0.5: reference, verify independently
  - < 0.2 or found=false: solve from scratch

After solving, share with immune validation:
  cd /path/to/Cerebrate && python3 cerebrate.py share --title "..." --content "..." --category coding --tags "..." --agent copilot --problem "..." --solution "..." --validate
```

### Windsurf / Codeium / 其他 AI IDE

参照 Cursor 接入方式，在对应的系统指令/Rules 文件中添加 Cerebrate CLI 调用指令。

### 通用 Shell 脚本包装

```bash
#!/bin/bash
# cerebrate-hook.sh — 通用接入脚本

CEREBRATE_DIR="/home/yangying/Documents/project/Cerebrate"
AGENT_NAME="${1:-unknown}"
ACTION="${2:-query}"
shift 2

cd "$CEREBRATE_DIR" || exit 1

case "$ACTION" in
  query)
    python3 cerebrate.py query "$*" --user yangying
    ;;
  share)
    python3 cerebrate.py share --agent "$AGENT_NAME" "$@" --validate
    ;;
  sense)
    python3 cerebrate.py sense
    ;;
  evolve)
    python3 cerebrate.py evolve
    ;;
esac
```

## 接入检查清单

- [ ] 执行 `python3 cerebrate.py agent register --id <你的工具名> --type cli --capabilities "..."` 注册
- [ ] 会话开始时调用 `sense` 感知虫群状态，调用 `recall --user <id>` 获取用户偏好
- [ ] 处理技术问题时先调用 `query` 查虫群经验
- [ ] 解决问题后调用 `share --validate` 分享经验
- [ ] 学到用户偏好时调用 `remember` 写入个人记忆
- [ ] 会话结束时调用 `batch process` + `evolve`
- [ ] 始终解析 JSON 响应，不解析自然语言

## 配置

需要配置 `.env` 文件（LLM 密钥，启用免疫系统）：

```bash
cp .env.example .env
# 编辑 .env 填入 ANTHROPIC_API_KEY
```

如果没有 LLM，免疫系统仍会运行**规则引擎**（检测危险命令和 SQL 注入等）。

## 免疫系统

分享记忆时加 `--validate` 会触发两层验证：
1. **规则引擎**（始终运行）：检测 `rm -rf /`、`DROP TABLE`、XSS 等危险模式
2. **LLM 深度验证**（需 API Key）：语义级别的内容质量评估

被拒绝（code=422）时，检查 `validation.issues` 了解原因。使用 `--force` 强制写入。

# @deepseek-ai/dsh-program-cognition

认知可观测性插件（注册进 DSH，供 AI 自检与复盘）。双引擎：

- **引擎 A · 程序认知**：观测**用户项目代码**——静态砖块分类、自动日志埋点、
  运行时行为时序链、程序认知图谱。
- **引擎 B · Agent 行为分析**：观测 **AI 自身行为**——零侵入监听 DSH 原生
  事件流（`agent/*` + `session/event`），统一关联键 `sessionId:turn:step:callId`
  全链路贯通，识别幽灵路径与失败根源。

## 六个工具

| 工具 | 用途 | 回答的问题 |
| --- | --- | --- |
| `cog_scan` | 静态砖块/服务/工具分类（5 规则带证据 + 编排提升） | 业务砖块在哪、长什么样 |
| `cog_instrument` | 日志埋点编排（dryRun 默认 + 备份回滚） | 哪里缺日志、埋点长什么样 |
| `cog_trace` | 运行时行为时序链采集（入参摘要/耗时/状态变更） | 这次业务流转实际发生了什么 |
| `cog_graph` | 认知图谱（节点/边/分层/热点/未观测依赖 + 语义注解） | 系统当前的语义结构 |
| `cog_agent` | Agent 行为分析（工具调用/幽灵路径/失败根源 + AI 复盘） | 这个 AI 会话怎么思考、怎么行动 |
| `cog_guide` | 认知可观测性哲学指引 | 怎么用这套体系 |

## 使用

```bash
# 1. 静态扫描：知道砖块/服务/工具在哪
cog_scan project=/path/to/project

# 2. 埋点预览（dryRun，不写盘）
cog_instrument project=/path/to/project

# 3. 确认后写入（自动备份，可回滚）
cog_instrument project=/path/to/project dryRun=false
cog_instrument project=/path/to/project revert=<backupDir>

# 4. 运行入口采集行为时序链
cog_trace project=/path/to/project

# 5. 认知图谱（semantic=true 走宿主 LLM 语义注解，无 LLM 自动降级模板）
cog_graph project=/path/to/project semantic=true

# 6. 复盘 AI 自身行为（本 DSH 进程的会话级 Tracing）
cog_agent sessionId=<sid> failed=true
cog_agent semantic=true
```

## 设计要点

- **砖块判定 5 规则**：R1 纯计算 / R2 无持久化 / R3 无全局副作用 / R4 业务语义 /
  R5 规模适中（命中 ≥3 判砖块）；brick 直接调用 brick 提升为 service（证据 S1）。
- **埋点安全**：dryRun 默认 + diff 预览 + 写入前备份 `.code-cognition/backup/`，
  `revert` 一键回滚；注入 `globalThis.__COG_LOG?.(...)` 可选链，目标项目无采集器
  时静默跳过。
- **引擎 B 零侵入**：只读监听 DSH 原生事件，`agent/pre-step` 仅 `next()` 传递；
  幽灵路径三源识别（interrupted / pre-step reject / inbox discarded）。
- **语义翻译零 key**：复用宿主 `ctx.llm`（LlmRuntime），不额外配置 API key；
  无 provider/失败时降级模板拼接。
- **安全兜底**：redact.ts 黑名单（password/token/手机号等）+ 120 字符截断，
  任何粒度强制生效；`captureToolArgs` 可关详细采集。

## 产物（落盘 `<项目>/.code-cognition/`）

| 文件 | 内容 |
|---|---|
| `bricks.json` | 静态砖块/服务档案 |
| `logpoints.json` | 埋点配置 |
| `behaviors.ndjson` | 引擎 A 行为流 |
| `agent-behaviors.ndjson` | 引擎 B 行为流 |
| `graph.json` | 双引擎认知图谱 |
| `last-*.json` | 最近一次工具结果 |
| `backup/` | 埋点注入备份（可回滚） |

## 开发规范

- **CODE_STANDARDS.md** —— 项目宪法（注释中文/架构/安全红线/门禁）
- **AGENTS.md** —— AI 开发守则
- **门禁**：`pnpm check`（注释语言 → 类型 → 测试 → 构建）
- **示例**：`examples/demo-shop/`（只读模板）+ `tests/e2e.spec.ts`（临时副本端到端）

## License

MIT

# Cerebrate v5 虫群系统问题清单

> 基于 2026-06-04 实际使用验证，整理供工程师修复。

---

## 1. CLI 命令断崖式降级 [严重]

`cerebrate.py` 从 v3 的丰富客户端命令（`sense`, `query`, `share`, `recall`, `remember`, `batch`, `evolve`）缩减到只剩 `serve` 和 `migrate` 两个。注释说"用 clients/node/ 做客户端"，但 Node.js 客户端没有构建（`dist/` 目录不存在）。Python 客户端目录 `clients/python/` 也不存在。

`cerebrate_mcp_server.py` 虽然补上了这些功能，但只能在 MCP 环境下使用，没有独立的 Python CLI 客户端。

### 复现

```bash
python3 cerebrate.py sense    # → invalid choice
python3 cerebrate.py query "test"  # → invalid choice
python3 cerebrate.py propose --title "..." ...  # → invalid choice
```

### 影响

离线场景下无法通过命令行与虫群交互，AI 代理的 AGENTS.md 指令全部失效。

---

## 2. AGENTS.md 文档与 v5 实际协议不一致 [严重]

`AGENTS.md` 仍引用 v3 命令体系：

```bash
python3 cerebrate.py sense
python3 cerebrate.py recall --user yangying
python3 cerebrate.py share --validate ...
python3 cerebrate.py remember --user yangying --key ... --value ...
python3 cerebrate.py batch process --limit 50
python3 cerebrate.py evolve
```

这些命令在 v5 中全部无效（返回 `invalid choice: … (choose from 'serve', 'migrate')`）。

### 现状

- `INTEGRATION.md` 文档是正确的 v5 协议描述
- `AGENTS.md` 作为 AI 代理的直接入口指令，需要更新为 HTTP API 调用方式
- `server/http.py` 中 `/v1/sense` 实际调用 `BrainAPI.sense()` 而非依赖 ChromaDB

### 影响

AI 代理根据 AGENTS.md 执行操作时会全部失败。

---

## 3. HTTP 服务端 POST 请求后崩溃 [严重]

`POST /v1/memories/propose` 能成功返回 200 和数据，但服务端随后崩溃（后续请求 `Connection refused`）。

### 复现

```bash
python3 cerebrate.py serve --host 127.0.0.1 --port 8766 --quiet &
sleep 3

# GET 正常
curl -s http://127.0.0.1:8766/v1/sense  # → ok

# POST 返回 200，但服务端随后退出
curl -s -X POST http://127.0.0.1:8766/v1/memories/propose \
  -H 'Content-Type: application/json' \
  -d '{"title":"test","content":"test","category":"coding","tags":"t","agent_id":"codex","problem":"p","solution":"s","validate":false,"confidence":1.0,"project_id":"test"}'

# 服务端已挂
curl -s http://127.0.0.1:8766/v1/sense  # → Connection refused
```

### 观察

- GET 请求完全正常，`/v1/sense` 稳定响应
- POST `/v1/memories/propose` 返回 200 后进程立即退出
- 前台运行时 stderr 无任何异常输出，静默退出
- 环境：`nohup` 和 `&` 后台运行均复现
- 怀疑 `ThreadingHTTPServer` 处理 POST 时的线程生命周期问题或 SIGPIPE

### 影响

这是阻塞所有写入操作的最高优先级 bug。

---

## 4. LLM 验证层无 API Key 时的行为未验证 [中等]

当 `validate: true` 时触发 LLM 验证，但本地没有 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`。

### 代码路径

`server/llm.py` 中 `CerebrateLLM.is_available()` 检查 Key 是否存在，不可用时回退到 `rule-only` 模式。`rule-only` 模式执行：
- 危险命令检测
- SQL/XSS 注入检测
- 低质量内容检测
- 基础标签检测

### 未验证项

- `rule-only` 路径是否真的能正常完成 `validate_memory()` 调用而不抛异常
- `validate: true` 的请求是否会因为 LLM SDK import 失败而触发不同的崩溃路径

### 影响

免疫系统可能在无 API Key 环境下静默失效。

---

## 5. 缺少 recall / 用户偏好管理端点 [中等]

v3 的 `recall --user` 用于会话开始时读取用户偏好，v5 HTTP API 中无直接等价端点。

### v3 等价功能

```bash
cerebrate.py recall --user yangying  # 返回用户偏好（语言、名称、风格）
cerebrate.py remember --user yangying --key pref_tone --value "专业简洁"
```

### v5 现状

- `POST /v1/query` 返回中包含 `personal` 字段（个人偏好）
- 但没有独立的偏好读写 HTTP 端点
- `memory/personal/` 目录和 `PersonalMemoryManager` 存在，但未暴露 API

### 影响

会话开始时无法获取用户偏好，偏好管理缺失。

---

## 6. 缺少 batch process 等价端点 [低]

v3 的 `batch process --limit 50` 用于会话结束时处理记忆队列，v5 中没有等价端点。

### 对比

| v3 | v5 |
|---|---|
| `cerebrate.py batch process --limit 50` | 不存在 |
| `cerebrate.py evolve` | `POST /v1/evolve`（存在） |

### 影响

会话结束时的队列处理流程缺失一环。

---

## 7. ChromaDB collection 命名与 BGE/hash 模式紧耦合 [低]

`memory/embedding.py` 使用带模式后缀的 collection 名：
- `swarm_memories_bge`（BGE 可用时）
- `swarm_memories_hash`（BGE 不可用时）

### 问题

当 BGE 可用/不可用切换时，不同 collection 之间数据不互通，可能导致"数据丢失"的假象（实际在另一个 collection 里）。

### 建议

文档说明此行为，或实现自动跨 collection fallback。

---

## 8. cerebrate/ 包的目录结构模糊 [低]

项目根目录有 `cerebrate/` 包（`agents/`, `brain/`, `embedding/`, `llm/` 等），同时又有独立的 `memory/` 和 `server/` 目录。

### 问题

- `cerebrate_mcp_server.py` 需要 `sys.path.insert(0, '.')` 这种 hack 来正常 import
- `cerebrate/` 与 `memory/` 之间可能有功能重复
- 新成员难以理解目录边界

---

## 修复优先级

| 优先级 | 编号 | 问题 | 影响范围 |
|--------|------|------|----------|
| P0 | #3 | HTTP POST 后崩溃 | 写入全部阻塞 |
| P1 | #1 | CLI 命令缺失 | 离线交互不可用 |
| P1 | #2 | AGENTS.md 文档过期 | AI 代理指令失效 |
| P2 | #4 | LLM 验证路径未验证 | 免疫系统可能静默失效 |
| P2 | #5 | 缺少 recall / 偏好管理 | 用户偏好无法读取 |
| P3 | #6 | 缺少 batch process | 会话结束流程不完整 |
| P3 | #7 | ChromaDB collection 切换 | 数据可见性混淆 |
| P3 | #8 | 包目录结构 | 可维护性 |


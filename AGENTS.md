# Cerebrate Protocol v5 — Root Split Brain Server

## 项目边界

Cerebrate 分六个模块层：

- **服务端** `server/`：脑虫中央处理器。负责记忆写入、事件日志、免疫隔离、复用反馈、共识投票、进化和 doctrine 输出。
- **大脑** `brain/`：决策与元认知层，包含事件、LLM、元认知评估、共识裁决。
- **记忆内核** `memory/`：服务端内部器官，包含 swarm、personal、knowledge、evolution、agents。
- **基础设施** `core/`：ChromaDB 向量存储、embedding 引擎、衰减算法、分块器、重排序。
- **文档存储** `memory/docstore.py`：文件系统文档存储，`{doc_id}.md`（纯 Markdown）+ `{doc_id}.json`（元数据）。
- **元数据层** `memory/metastore.py`：可选 PostgreSQL 元数据存储，无 PG 时自动降级。
- **客户端** `client/`：给 AI 作战单位访问服务端。只能提交请求、候选经验、复用反馈和投票。不能直接写群体记忆，不能直接晋升 doctrine。

`cerebrate.py` 是统一入口：`serve/migrate` 分发到服务端 CLI，其余命令分发到客户端 CLI。

## 服务端启动

```bash
python3 cerebrate.py serve --host 127.0.0.1 --port 8765
```

服务端第一行输出：

```json
{
  "status": "ok",
  "data": { "base_url": "http://127.0.0.1:8765" },
  "meta": { "protocol": "v5" }
}
```

## 响应协议

成功：

```json
{ "status": "ok", "data": {}, "meta": { "protocol": "v5" } }
```

失败：

```json
{
  "status": "error",
  "error": { "code": 500, "message": "...", "details": {} },
  "meta": { "protocol": "v5" }
}
```

## HTTP API

- `POST /v1/agents/register`
- `GET /v1/sense`
- `GET /v1/help`
- `GET /v1/brain/assess`
- `GET /v1/llm/status`
- `POST /v1/query`
- `POST /v1/memories/propose`
- `POST /v1/usages/start`
- `POST /v1/usages/finish`
- `POST /v1/consensus/vote`
- `GET /v1/consensus/{memory_id}`
- `GET /v1/events?cursor=0&limit=100`
- `GET /v1/events/stream?cursor=0`
- `GET /v1/memories/{id}`
- `GET /v1/doctrines`
- `POST /v1/evolve`

- `GET /v1/personal` (个人偏好读取)
- `POST /v1/personal` (个人偏好写入: {"user":"...", "key":"...", "value":"..."})
- `POST /v1/batch/process` (批量处理: {"limit":50})

## CLI 客户端

```bash
python3 cerebrate.py register --url http://127.0.0.1:8765 --id codex
python3 cerebrate.py sense --url http://127.0.0.1:8765
python3 cerebrate.py query --url http://127.0.0.1:8765 "如何接入脑虫"
python3 cerebrate.py propose --url http://127.0.0.1:8765 --title "经验" --content "..." --category coding --agent codex
python3 cerebrate.py use start --url http://127.0.0.1:8765 --memory-id <id> --agent codex --problem "..."
python3 cerebrate.py use finish --url http://127.0.0.1:8765 --usage-id <id> --outcome success --feedback "..."
python3 cerebrate.py vote --url http://127.0.0.1:8765 --memory-id <id> --agent codex --vote support --evidence "..."
python3 cerebrate.py consensus --url http://127.0.0.1:8765 --memory-id <id>
python3 cerebrate.py memory-get --url http://127.0.0.1:8765 --memory-id <id>
python3 cerebrate.py llm status --url http://127.0.0.1:8765
python3 cerebrate.py brain assess --url http://127.0.0.1:8765
python3 cerebrate.py events --url http://127.0.0.1:8765 --cursor 0
```

## 连接策略

- REST 短请求承载命令和事实提交。
- 持久 `event log` 承载记忆连续性。
- SSE 长连接只负责广播和观察。
- 记忆绝不依赖长连接是否存活。

客户端断线后用 `cursor` 从 `GET /v1/events` 或 `GET /v1/events/stream` 继续同步。

## 权威规则

客户端可以提交：

- 候选记忆 `memory`
- 养分 `nutrient`
- 复用反馈
- 共识投票事件

客户端不能提交：

- `verified_skill`
- `doctrine`
- 直接删除群体记忆
- 直接篡改共识结果

晋升必须由服务端进化、免疫和共识裁决完成。

## 记忆内核规则

- `memory/swarm.py`：群体记忆与生命周期，服务端写入候选经验、隔离内容、复用反馈。
- `memory/knowledge.py`：权威知识库，保存策略/文档类知识。
- `memory/personal.py`：个人上下文缓存与持久化。
- `core/embedding.py`：向量化引擎，BGE 优先，本地 hash 保底。
- `core/storage.py`：ChromaDB 向量存储。
- 旧 TF-IDF `SemanticIndex` 已删除，不再维护 `_semantic_index.json` 或重建语义索引入口。

## 脑虫裁决与 LLM

- `vote` 只提交共识事件，不直接改写 doctrine。
- 服务端用 `GET /v1/consensus/{memory_id}` 聚合每个智能体的最新投票，结合置信度、证据长度、智能体成功率和法定人数生成 `pending | accepted | rejected | split`。
- 达成接受共识时，服务端最多自动晋升为 `verified_skill`；`doctrine` 仍由服务端进化流程沉淀。
- 达成拒绝共识时，服务端可隔离为 `quarantined`。
- 内置 LLM 是可选免疫增强层；没有 API key 或 SDK 时自动进入 `rule-only`，仍会用规则检测危险命令、低质量内容和基础标签。

# Cerebrate Protocol v5 — Brain Server First

## 项目边界

Cerebrate 现在明确分为两层：

- **服务端项目**：`cerebrate/server/`
  - 脑虫中央处理器，唯一权威入口。
  - 负责记忆写入、事件日志、免疫隔离、复用反馈、共识投票、进化和 doctrine 输出。
- **客户端项目**：`cerebrate/client/` + `cerebrate.py`
  - 给 AI 作战单位访问服务端。
  - 只能提交请求、候选经验、复用反馈和投票。
  - 不能直接写群体记忆，不能直接晋升 doctrine。

历史的本地直写式 CLI / IPC batch 已废弃。CLI 不再是权威记忆系统，只是服务端启动器和 HTTP 客户端。

## 服务端启动

```bash
python3 cerebrate.py serve --host 127.0.0.1 --port 8765
```

服务端第一行输出：

```json
{"status":"ok","data":{"base_url":"http://127.0.0.1:8765"},"meta":{"protocol":"v5"}}
```

## 响应协议

成功：

```json
{"status":"ok","data":{},"meta":{"protocol":"v5"}}
```

失败：

```json
{"status":"error","error":{"code":500,"message":"...","details":{}},"meta":{"protocol":"v5"}}
```

## HTTP API

- `POST /v1/agents/register`
- `GET /v1/sense`
- `POST /v1/query`
- `POST /v1/memories/propose`
- `POST /v1/usages/start`
- `POST /v1/usages/finish`
- `POST /v1/consensus/vote`
- `GET /v1/events?cursor=0&limit=100`
- `GET /v1/events/stream?cursor=0`
- `GET /v1/memories/{id}`
- `GET /v1/doctrines`
- `POST /v1/evolve`

## CLI 客户端

```bash
python3 cerebrate.py register --url http://127.0.0.1:8765 --id codex
python3 cerebrate.py sense --url http://127.0.0.1:8765
python3 cerebrate.py query --url http://127.0.0.1:8765 "如何接入脑虫"
python3 cerebrate.py propose --url http://127.0.0.1:8765 --title "经验" --content "..." --category coding --agent codex
python3 cerebrate.py use start --url http://127.0.0.1:8765 --memory-id <id> --agent codex --problem "..."
python3 cerebrate.py use finish --url http://127.0.0.1:8765 --usage-id <id> --outcome success --feedback "..."
python3 cerebrate.py vote --url http://127.0.0.1:8765 --memory-id <id> --agent codex --vote support --evidence "..."
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

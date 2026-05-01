# Cerebrate v5 接入指南

## 哪个是服务端，哪个是客户端？

服务端：

- `server/`
- 这是脑虫中央处理器。
- 所有群体记忆、事件日志、共识和进化都由服务端控制。

客户端：

- `client/`
- 这是 AI 单位访问服务端的安装包/适配层，不拥有权威记忆。

记忆内核：

- `memory/`
- 这是服务端内部器官，不是客户端项目。

兼容入口：

- `cerebrate.py`
- 只负责开发期分发命令：`serve/migrate` 进入服务端 CLI，其余命令进入客户端 CLI。

## 启动服务端

```bash
python3 cerebrate.py serve --host 127.0.0.1 --port 8765
```

## AI 单位接入

```bash
python3 cerebrate.py register --url http://127.0.0.1:8765 --id my-agent --capabilities "debugging,coding"
python3 cerebrate.py sense --url http://127.0.0.1:8765
python3 cerebrate.py query --url http://127.0.0.1:8765 "问题描述" --agent my-agent
```

提交候选经验：

```bash
python3 cerebrate.py propose \
  --url http://127.0.0.1:8765 \
  --title "修复离线查询" \
  --content "BGE 不可用时服务端使用 deterministic hash embedding" \
  --category debugging \
  --agent my-agent \
  --solution "服务端保证 embedding function 总是存在"
```

复用反馈：

```bash
python3 cerebrate.py use start \
  --url http://127.0.0.1:8765 \
  --memory-id <memory_id> \
  --agent my-agent \
  --problem "问题描述"

python3 cerebrate.py use finish \
  --url http://127.0.0.1:8765 \
  --usage-id <usage_id> \
  --outcome success \
  --feedback "方案有效"
```

共识投票：

```bash
python3 cerebrate.py vote \
  --url http://127.0.0.1:8765 \
  --memory-id <memory_id> \
  --agent my-agent \
  --vote support \
  --evidence "有测试或复现证据"

python3 cerebrate.py consensus \
  --url http://127.0.0.1:8765 \
  --memory-id <memory_id>
```

## 重要原则

单个 AI 单位不能篡改群体记忆。

客户端提交的是：

- 战报
- 候选记忆
- 使用反馈
- 共识投票

服务端决定：

- 是否隔离
- 是否吸收
- 是否晋升为 `verified_skill`
- 是否固化为 `doctrine`

共识不是简单多数。脑虫需要结合来源可信度、证据质量、复用成功率、失败反馈、时间衰减和冲突检测。

## 脑虫状态和 LLM 免疫层

元认知评估：

```bash
python3 cerebrate.py brain assess --url http://127.0.0.1:8765
```

LLM/免疫状态：

```bash
python3 cerebrate.py llm status --url http://127.0.0.1:8765
```

内置 LLM 的工作方式：

- `server/llm.py` 是可选增强层，不是强依赖。
- 有 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 且对应 SDK 可用时，进入 `llm-assisted`。
- 无 API key、SDK 不存在或调用失败时，进入 `rule-only`。
- `rule-only` 仍会执行危险命令、SQL/XSS、低质量内容和基础标签检测。
- LLM 主要负责深度质量审核、标签建议、摘要和知识冲突检测；最终写入、晋升和隔离仍由服务端规则裁决。

## 事件日志

服务端将事实追加到 `memory/events/events.jsonl`。

读取事件：

```bash
python3 cerebrate.py events --url http://127.0.0.1:8765 --cursor 0
```

SSE：

```http
GET /v1/events/stream?cursor=0
```

连接只是神经信号，事件日志才是脑组织。

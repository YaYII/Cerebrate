# Cerebrate v4 接入指南

Cerebrate 是文件系统驱动的脑虫记忆中枢。AI 编程工具可以直接调用 CLI，或通过 JSON 文件队列接入。v4 是严格 JSON 协议：成功结果只读 `data`，错误只读 `error`。

## 30 秒接入

```bash
cd /path/to/Cerebrate

python3 cerebrate.py agent register \
  --id my-agent \
  --type cli \
  --capabilities "code_generation,debugging"

python3 cerebrate.py sense

python3 cerebrate.py query "如何修复离线向量查询失败" --user yangying
```

成功响应:
```json
{"status":"ok","data":{},"meta":{"protocol":"v4"}}
```

失败响应:
```json
{"status":"error","error":{"code":500,"message":"...","details":{}},"meta":{"protocol":"v4"}}
```

## 推荐工作流

1. 会话开始：`agent register` + `sense`
2. 遇到问题：`query`
3. 若 `data.recommendation` 是 `reuse` 或 `verify`：调用 `use start`
4. 任务结束：调用 `use finish`
5. 新经验：调用 `share --validate`
6. 会话结束：`batch process`，必要时 `evolve`

## 查询和复用反馈

```bash
python3 cerebrate.py query "问题描述" --user yangying --project cerebrate
```

`data.recommendation`:
- `reuse`: 可直接复用
- `verify`: 参考但需要独立验证
- `new_experience`: 新问题，解决后应分享

开始复用:
```bash
python3 cerebrate.py use start \
  --memory-id <memory_id> \
  --agent my-agent \
  --problem "问题描述"
```

结束复用:
```bash
python3 cerebrate.py use finish \
  --usage-id <usage_id> \
  --outcome success \
  --feedback "方案有效"
```

## 分享记忆

```bash
python3 cerebrate.py share \
  --title "修复离线查询" \
  --content "BGE 不可用时使用 deterministic hash embedding" \
  --category debugging \
  --tags "embedding,offline" \
  --agent my-agent \
  --problem "无网络时 Chroma query 崩溃" \
  --solution "为 ChromaStore 始终提供 embedding function" \
  --validate
```

被免疫系统判定低质量或危险的内容会进入 `quarantined` 生命周期，不会污染正常查询结果。

## 记忆生命周期

- `nutrient`: 养分种子，待吸收
- `memory`: 正常经验
- `verified_skill`: 进化提炼出的高可信技能
- `doctrine`: 跨项目稳定教条
- `quarantined`: 被免疫系统隔离
- `archived`: 已归档

## 离线 embedding

默认策略是：本地可用 BGE 优先，否则回退到 deterministic hash embedding。默认不会联网下载模型。需要允许下载时设置：

```bash
CEREBRATE_EMBEDDING_ALLOW_DOWNLOAD=true
```

## 种子导出与重建索引

运行时 ChromaDB 是可重建索引。长期养分使用 JSONL：

```bash
python3 cerebrate.py migrate --export-seeds
python3 cerebrate.py migrate --reindex
```

## IPC 队列

提交请求到：
`memory/.queue/requests/<request_id>.json`

读取结果：
`memory/.queue/results/<request_id>.result.json`

批处理：
```bash
python3 cerebrate.py batch process --limit 50
```

支持命令：`query`, `share`, `remember`, `recall`, `store-kb`, `stats`, `sense`, `evolve`, `register`。

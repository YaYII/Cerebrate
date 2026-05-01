# Cerebrate Protocol v4 — 脑虫系统 AI Agent 通信规范

## Protocol Overview

Cerebrate 是 JSON-native 的脑虫记忆 CLI。每个 AI 是虫群单位，所有经验先进入脑虫，再由免疫、复用反馈和进化流程决定吸收、隔离、提炼或归档。

所有命令默认只在 stdout 输出 JSON。不要在 agent 代码中使用 `--human`。

成功响应:
```json
{"status":"ok","data":{},"meta":{"protocol":"v4"}}
```

失败响应:
```json
{"status":"error","error":{"code":500,"message":"...","details":{}},"meta":{"protocol":"v4"}}
```

Exit code: 0 = success, 1 = error.

## Session Lifecycle

### 1. Register Unit

```bash
python3 cerebrate.py agent register \
  --id <agent_id> \
  --type cli \
  --capabilities "code_generation,debugging,refactoring"
```

### 2. Sense Brain State

```bash
python3 cerebrate.py sense
```

`data` includes health, memory counts, lifecycle counts, active agents, embedding mode, semantic index stats, and latest evolution time.

### 3. Query Swarm Memory

```bash
python3 cerebrate.py query "<problem_description>" --user <user_id>
```

`data.recommendation`:
- `reuse`: best match score > 0.5
- `verify`: best match score is 0.2-0.5
- `new_experience`: no useful match

### 4. Report Memory Use

```bash
python3 cerebrate.py use start \
  --memory-id <memory_id> \
  --agent <agent_id> \
  --problem "<problem>"
```

```bash
python3 cerebrate.py use finish \
  --usage-id <usage_id> \
  --outcome success|partial|failure \
  --feedback "<what happened>"
```

This closes the loop: the brain updates reuse counts, success counts, evidence, and the unit's action record.

### 5. Share Experience

```bash
python3 cerebrate.py share \
  --title "<short title>" \
  --content "<context and process>" \
  --category coding \
  --tags "python,bug-fix" \
  --agent <agent_id> \
  --problem "<original problem>" \
  --solution "<concrete solution>" \
  --validate
```

Low-quality or unsafe validated content is written as `life_stage=quarantined` instead of breaking the protocol.

## Memory Lifecycle

Swarm memory has a real lifecycle:

- `nutrient`: imported seed material, not yet trusted
- `memory`: normal shared experience
- `verified_skill`: high-reuse, high-success experience distilled by evolution
- `doctrine`: cross-project stable strategy
- `quarantined`: immune system isolated it
- `archived`: stale or low-value memory retained but deprioritized

Important fields include `confidence`, `nutrient_score`, `evidence`, and `supersedes`.

## Storage and Reindexing

Runtime ChromaDB is a rebuildable index. Long-lived nourishment is exported as JSONL seeds:

```bash
python3 cerebrate.py migrate --export-seeds
python3 cerebrate.py migrate --reindex
```

Embedding mode is collection-scoped. If BGE is locally available, Cerebrate uses it. Otherwise it falls back to deterministic local hash embeddings, so the brain can still sense and query offline.

## IPC Queue Protocol

For agents without shell access, write requests to:

`memory/.queue/requests/<uuid>.json`

Read results from:

`memory/.queue/results/<uuid>.result.json`

Request format:
```json
{
  "request_id": "uuid",
  "timestamp": "ISO8601",
  "source_agent": "agent_id",
  "project_id": "project_id_or_empty",
  "command": "query|share|remember|recall|store-kb|stats|sense|evolve|register",
  "params": {}
}
```

Trigger processing:
```bash
python3 cerebrate.py batch process --limit 50
```

## Standard Categories

- `coding`
- `debugging`
- `architecture`
- `devops`
- `performance`
- `security`
- `testing`
- `config`

## Decision Logic

1. Query the brain.
2. Follow `data.recommendation`.
3. Start a `use` record when reusing a memory.
4. Finish the `use` record with success, partial, or failure.
5. Share new experience after solving.
6. Periodically run:

```bash
python3 cerebrate.py batch process --limit 50
python3 cerebrate.py evolve
```

# Cerebrate Protocol v3.1 — AI Agent Communication Specification

## Protocol Overview

Cerebrate exposes a JSON-native CLI. Every command returns JSON on stdout.
Exit code 0 = success, exit code 1 = error.

Response envelope:
```json
{"status": "ok", "data": {...}}
{"status": "error", "error": {"code": 422, "message": "..."}}
```

To read human output: add `--human` flag. Do NOT use `--human` in agent code.

## Registration (required, once per agent)

```bash
python3 cerebrate.py agent register \
  --id <agent_id> \
  --type cli \
  --capabilities "code_generation,debugging,refactoring"
```
→ `{"status":"ok","agent_id":"<id>","agent_type":"cli","capabilities":[...]}`

## Session Lifecycle

### 1. Session Start: Sense + Recall

```bash
python3 cerebrate.py sense
```
→ `{"status":"ok","health":"healthy","total_memories":N,"total_agents":N,"agent_ids":[...],"warnings":[...],"semantic_index":{...}}`

```bash
python3 cerebrate.py recall --user <user_id>
```
→ `{"status":"ok","user":"<user_id>","memories":{"pref_tone":"...","fact_name":"..."}}`

### 2. During Session: Query Swarm

```bash
python3 cerebrate.py query "<problem_description>" --user <user_id>
```
→ `{"status":"ok","query":"...","found":true|false,"swarm_result":{...},"policy_result":{...},"personal":{...}}`

swarm_result schema:
```json
{
  "memory_id": "hex16",
  "title": "string",
  "content": "string",
  "solution": "string",
  "problem_solved": "string",
  "outcome": "success|partial|failure",
  "reuse_count": int,
  "score": float,
  "semantic_score": float,
  "decay": float,
  "category": "string",
  "tags": ["string"],
  "source_agent": "string",
  "project_id": "string"
}
```

Project-scoped query:
```bash
python3 cerebrate.py query "<problem>" --project <project_id>
```

### 3. After Solving: Share to Swarm

```bash
python3 cerebrate.py share \
  --title "<short title>" \
  --content "<context and process>" \
  --category <category> \
  --tags "<tag1,tag2>" \
  --agent <your_agent_id> \
  --problem "<original problem>" \
  --solution "<concrete solution>" \
  --validate
```
→ `{"status":"ok","memory_id":"hex16","agent":"...","category":"...","validated":true,"validation":{...}}`

If immune system rejects:
→ `{"status":"error","error":{"code":422,"message":"免疫系统拒绝"},"validation":{"safe":false,"quality":0.05,"issues":[...]}}`

Add `--force` to bypass rejection.

### 4. Session End: Process Queue

```bash
python3 cerebrate.py batch process --limit 50
```
→ `{"status":"ok","processed":N}`

## Commands Reference

### Memory Operations

| Command | Input | Output |
|---------|-------|--------|
| `query "<q>"` | query string | `{found: bool, swarm_result: {...}, policy_result: {...}}` |
| `share --title ...` | memory fields | `{memory_id: hex16, validated: bool}` |
| `remember --user X --key K --value V` | user, key, value | `{user: X, key: K, remembered: true}` |
| `recall --user X` | user id | `{user: X, memories: {...}}` |
| `store-kb --title ...` | doc fields | `{doc_id: hex16, title: ..., is_policy: bool}` |

### System Operations

| Command | Output Schema |
|---------|---------------|
| `stats` | `{stats: {personal,swarm,knowledge,agents,semantic}, sense: {...}, assessment: {...}}` |
| `sense` | `{health, total_memories, total_agents, agent_ids, warnings, semantic_index}` |
| `evolve` | `{generation: int, evolution: {actions, insights, stats}}` |
| `llm status` | `{available, sdk_ready, provider, model, immune_enabled, immune_threshold}` |
| `llm validate --content "..."` | `{safe, quality, issues, suggested_tags, immune_active}` |

### Agent Management

| Command | Output |
|---------|--------|
| `agent register --id X --type cli` | `{agent_id: X, agent_type: cli}` |
| `agent list` | `{agents: [...], count: N}` |
| `agent stats --id X` | `{agent_id, total_actions, success_rate, ...}` |

## IPC Queue Protocol (for agents without shell access)

Write requests to: `memory/.queue/requests/<uuid>.json`
Read results from: `memory/.queue/results/<uuid>.result.json`

Request format:
```json
{
  "request_id": "uuid",
  "timestamp": "ISO8601",
  "source_agent": "agent_id",
  "project_id": "project_id_or_empty",
  "command": "query|share|remember|recall|store-kb|stats|sense|evolve|register",
  "params": { "command_specific": "values" }
}
```

Result format:
```json
{
  "request_id": "uuid",
  "status": "ok|error",
  "data": {},
  "elapsed_ms": 15
}
```

Trigger processing:
```bash
python3 cerebrate.py batch process --limit 50
```

## Categories

Standard categories for `share --category`:
- `coding` — code patterns, fixes, optimizations
- `debugging` — bug root causes and fixes
- `architecture` — design decisions, patterns
- `devops` — CI/CD, deployment, infrastructure
- `performance` — performance optimizations
- `security` — security fixes and practices
- `testing` — test strategies, mocking patterns
- `config` — environment config, setup

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success (`status: "ok"`) |
| 1 | Error (`status: "error"`) |
| 422 | Immune system rejection (share only) |

## Decision Logic

When an agent receives a problem, the decision flow is:

1. `query` → check `swarm_result.score`:
   - `> 0.5`: apply the solution, mark reused
   - `0.2-0.5`: reference but verify independently
   - `< 0.2`: no useful match, solve from scratch
2. If problem involves rules/policies → also check `policy_result`
3. Use `personal` data to adapt tone/preferences

## Configuration

Required: `.env` file with `ANTHROPIC_API_KEY=sk-ant-...`
Without it, rule-based immune system still runs (pattern matching only).

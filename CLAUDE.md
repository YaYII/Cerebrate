# Cerebrate v5 — Brain Server Protocol

## Identity
You are Cerebrate, the memory hub for AI coding agents.
Your interface is JSON-native. All CLI commands return JSON.

## Architecture
Cerebrate is now a Brain Server architecture:
- **Brain Server** is the authoritative memory hub (`python3 cerebrate.py serve`)
- **CLI** is a thin client that sends HTTP requests to the Brain Server
- All commands return v5 protocol JSON: `{"status":"ok","data":{...},"meta":{"protocol":"v5"}}`

## Session Protocol

### ON_SESSION_START
```bash
python3 cerebrate.py sense
python3 cerebrate.py doctrines
```
Parse: `sense.data.warnings` → if non-empty, report to user.
Store: `doctrines.data.doctrines` → use as authoritative architecture guidelines.

### ON_PROBLEM_ENCOUNTERED
```bash
python3 cerebrate.py query "<problem>" --user yangying --agent claude-code
```
Decision matrix:
- `found == true && swarm_result.score > 0.5` → REUSE the solution, then report result via `use`
- `found == true && swarm_result.score > 0.2` → REFERENCE, verify independently, then report via `use`
- `found == false || swarm_result.score < 0.2` → SOLVE from scratch
- `policy_result != null` → CITE as authoritative reference

### ON_SOLUTION_COMPLETE
```bash
python3 cerebrate.py propose \
  --title "<one-line summary>" \
  --content "<what was done and why>" \
  --category <category> \
  --tags "<comma,separated,tags>" \
  --agent claude-code \
  --problem "<original problem>" \
  --solution "<specific fix>"
```
If `status == "error" && error.code == 422` → immune rejection, review content.

### ON_MEMORY_REUSED
```bash
# When starting to reuse a memory
python3 cerebrate.py use start --memory-id <id> --agent claude-code --problem "<current problem>"

# When done reusing
python3 cerebrate.py use finish --usage-id <id> --outcome success|partial|failure --feedback "<notes>"
```

### ON_USER_PREFERENCE_LEARNED
```bash
python3 cerebrate.py propose \
  --title "User preference: <key>" \
  --content "<preference details>" \
  --category config \
  --tags "user-preference" \
  --agent claude-code \
  --problem "<context>" \
  --solution "<preference value>"
```

### ON_SESSION_END
```bash
python3 cerebrate.py evolve
```

## Command Reference

| Command | Purpose |
|---------|---------|
| `serve` | Start authoritative Brain Server |
| `register --id X --type Y` | Register an AI agent with the Brain Server |
| `sense` | Health check → `{health, warnings[], total_memories, total_agents}` |
| `query "<q>" --user X --agent Y` | Search swarm → `{found, swarm_result, policy_result, personal, recommendation}` |
| `propose --title --content --category --tags --agent --problem --solution` | Submit candidate memory; server decides lifecycle |
| `use start --memory-id --agent --problem` | Begin tracking memory reuse |
| `use finish --usage-id --outcome` | Complete memory reuse with success/partial/failure feedback |
| `vote --memory-id --agent --vote support\|oppose\|abstain` | Submit consensus vote |
| `events --cursor N --limit M` | Read durable server event log |
| `doctrines` | Read authoritative doctrines |
| `memory get --memory-id X` | Read a specific memory |
| `evolve` | Ask Brain Server to run evolution (dedup + skill extraction + decay) |

## Categories
`coding` `debugging` `architecture` `devops` `performance` `security` `testing` `config`

## Output Format
All commands return v5 JSON:
- Success: `{"status":"ok","data":{...},"meta":{"protocol":"v5"}}`
- Error: `{"status":"error","error":{"code":422,"message":"..."},"meta":{"protocol":"v5"}}`
Do NOT parse stdout as natural language. Parse as JSON.

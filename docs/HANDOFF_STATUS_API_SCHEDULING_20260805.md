# 交接文档：GET /v1/status 服务状态调度信号

> 日期：2026-08-05 ｜ 提交：`763fd66` ｜ 分支：master ｜ 作者：codex

## 1. 任务背景与需求

用户提出：脑虫不应该是冷冰冰的强制查询机器，而应该是**可感知、可调度的智能体**。

诉求拆解：
1. 需要一个「当前服务状态」API，让 AI 知道脑虫状况（embedding/LLM 可用性、负载、查询缓存命中率），从而综合调度。
2. 记忆查询可灵活调度——可以先查代码再查记忆（交叉印证），不必每次都机械强制先查记忆。
3. 契约层配合：让 Claude Code / Qoder / Codex 三端都按「感知状态 → 灵活调度」工作。

## 2. 已完成内容

### 2.1 新增 `GET /v1/status`（5s TTL 轻量接口）

返回（真实数据已验证）：
```json
{
  "health": "healthy",
  "embedding": {"mode": "bge", "fulltext": true},
  "llm": {"available": true, "provider": "deepseek", "immune_enabled": true},
  "load": {"usage_records": 3, "active_agents": 12},
  "query_cache": {"size": 0, "capacity": 512, "hits": 0, "misses": 0, "hit_rate": 0.0},
  "counts": {"total_memories": 1093, "kb_docs": 161},
  "recommended": "full"
}
```

`recommended` 规则（不依赖 LLM）：
- `full`：bge + LLM 可用 + 无积压 → 可全力查询（先代码后记忆/先记忆后代码都行）
- `light`：embedding 退化 hash / FTS 关闭 / LLM 不可用 → 轻量精确检索
- `defer`：usage_records>2000 且 active_agents>10 → 先做本地代码调研，记忆查询延后

### 2.2 查询缓存计数（`embedding.py`）

- `encode_query` 增加命中/未命中计数（`_query_cache_hits/_query_cache_misses`，线程安全）
- 新增模块级 `query_cache_stats()` → `{size, capacity, hits, misses, hit_rate}`
- 真实验证：2 次相同搜索后 `{size:2, hits:1, misses:2, hit_rate:0.333}`

### 2.3 契约升级（三端生效）

- `AGENTS.md`「记忆使用契约」：第 1 条加 `/v1/status` 感知；第 2 条改为「感知状态→按场景灵活调度」（先代码后记忆互证 / defer 时延后）
- 服务端 `/v1/soul` 升级 **v1.1**（`fb1f748665d8f792`，旧版 `2d2f8d9516267590` 已归档），新增「记忆使用契约：感知状态→灵活调度」小节——Claude Code / Qoder 会话开始自动注入

## 3. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 新增独立 `/v1/status` 而非扩展 sense | sense 带 recent_index 等重内容且 60s TTL；status 要轻量（无全库统计）+ 5s TTL |
| pending_usages 改为 O(1) `usage_records` | 精确 pending 需全量扫描 usage 库，违背轻量原则；总数+活跃数已足够作繁忙信号 |
| recommended 用规则判定 | 不依赖 LLM，保证 status 本身快速可靠 |
| soul 通过服务端权威通道更新 | 客户端 propose 不能写 doctrine；soul 是跨项目通用行为准则，Claude Code/Qoder hooks 自动注入 |
| 查询缓存计数用模块级 global | 与 `_query_cache` 同生命周期，`_query_cache_lock` 保护 |

## 4. 遗留问题

- `tests/test_http_brain_server.py` 3 个 HTTP 子进程用例在本沙箱**预先失败**（stash 验证确认非本次回归；JSONDecodeError 于服务器首行，疑似子进程 stdout 读取问题）
- `/v1/status` 尚无独立 HTTP 端到端测试（test_status.py 覆盖 BrainAPI 层 + help 登记，未起真实端口）
- `search` 内部对同一查询产生 2 次 encode（size=2）——疑似 hybrid 双通道/重写，不影响功能，可后续优化

## 5. 下一步建议

- 让 Claude Code / Qoder 客户端工作流显式调用 `/v1/status`（hooks 注入 status 摘要）
- 如团队并发大增，评估 `CEREBRATE_EMBEDDING_QUERY_CACHE` 调大（512→2048，每千条约 2MB）
- 补 HTTP 端到端测试时优先解决 test_http_brain_server.py 子进程预失败问题

## 6. 关键文件与命令

```bash
# 接口（Docker 服务 127.0.0.1:8765）
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/status
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/help   # commands 含 status

# 测试
python3 -m pytest tests/test_status.py -v          # 新用例（5 个）
python3 -m pytest tests/test_soul.py tests/test_progressive_disclosure.py tests/test_memory_scope.py -q  # 回归

# 构建部署
docker compose build cerebrate && docker compose up -d cerebrate

# soul 更新（CLI）
CEREBRATE_SERVER_TOKEN=$TOKEN python3 cerebrate.py --url http://127.0.0.1:8765 soul get
CEREBRATE_SERVER_TOKEN=$TOKEN python3 cerebrate.py --url http://127.0.0.1:8765 soul set --content-file /path/to/soul.md --agent codex
```

改动文件：`cerebrate/server/api.py`（status + help）、`cerebrate/server/http.py`（路由）、
`cerebrate/core/embedding.py`（query_cache_stats + 计数）、`AGENTS.md`（契约）、`tests/test_status.py`（新增）

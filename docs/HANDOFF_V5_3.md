# Cerebrate v5.3 交接文档 — 渐进式披露 + 结构化字段 + FTS5 + MCP 工作流

> 交接日期：2026-08-01
> 交接人：AI 工程师（v5.3 实施）
> 上游文档：`docs/DESIGN_OPTIMIZATION_V5_3.md`（设计+实施记录）、`docs/MEMORY_SCOPE_UPGRADE.md`（v5.2）

> **状态更新（2026-08-03，v5.4 接续）**：本交接文档的"待提交"状态已由 v5.4 完成 ——
> v5.3 提交已推入 main（094a953 + be3656d），13 个失败测试全部清零，
> knowledge 已接入 FTS5，sense 新增 recent_index。见 `docs/HANDOFF_V5_4.md`。

---

## 1. 任务背景与需求

用户要求升级 Cerebrate：**记忆太通用，需要项目隔离**（v5.2，已完成），
并以项目设计师身份学习开源项目 **claude-mem** 的设计吸收优点（v5.3，本次完成）。

claude-mem 核心优点（已逐条核验官方文档）：
- 渐进式披露 3 层检索（索引→时间线→详情），token 省 50-75%
- 检索成本可见（索引每行标 ~token 数）
- MCP 工具精简（9→4），工具设计强制工作流
- FTS5 全文检索（sub-10ms，注入转义）+ 向量混合
- 结构化 observation 字段（type/facts/concepts）

## 2. 已完成内容

### v5.2（已提交 3b339c2）
- scope 分类（general/project/all）：通用记忆查询绝不混入项目记忆
- 见 `docs/MEMORY_SCOPE_UPGRADE.md`

### v5.3（本次，待提交）
| 阶段 | 内容 | 关键文件 |
|---|---|---|
| Phase 1 | `/v1/search`（索引层）、`/v1/timeline`（上下文层）、`/v1/memories/detail`（详情层）；`swarm.query(index_only)`；`token_estimate` | swarm.py / api.py / http.py / cli.py / events.py |
| Phase 4 | `observation_type`/`facts`/`concepts` 规则提取 + LLM 增强（开关默认关）；标题语义压缩 | swarm.py / llm.py / config.py / api.py |
| Phase 3 | FTS5 全文索引（trigram，零新依赖）；share 双写；hybrid/fts/vector 三模式；`fulltext rebuild` | **新增** core/fulltext.py / swarm.py / api.py / cli.py |
| Phase 2 | MCP 新增 search/timeline/detail；sense 带 3-LAYER WORKFLOW 引导；4 工具 deprecated | mcp.py |

### 验证证据
- 新增 4 个测试文件共 29 个测试：`test_progressive_disclosure.py`(9)、
  `test_structured_fields.py`(8)、`test_fulltext.py`(7)、`test_mcp_workflow.py`(5)
- 全量：**161 passed / 13 failed**，13 个失败与 v5.2 基线完全一致（git stash 对比验证），0 新回归
- E2E 真实服务器验证：propose→search(hybrid/fts/vector)→timeline→detail→query(detail=false)→rebuild→sense 全通过

## 3. 关键决策与理由

1. **`/v1/query` 默认保持全文+决策**（detail=true）：回归测试证明默认索引模式破坏既有契约。
   索引层由新端点 `/v1/search` 承担；`detail=false` 提供显式轻量模式。
2. **FTS5 用 SQLite trigram**：中英文子串都支持；2 字以下中文自动 LIKE 回退。
3. **FTS5 路径动态派生自 memory_root**：防止测试污染项目真实库。
4. **LLM 结构化增强默认关闭**（`CEREBRATE_TITLE_COMPRESS_ENABLED` / `CEREBRATE_STRUCTURED_ENRICH_ENABLED`）：
   规则提取始终生效，LLM 增强需显式开启避免写路径延迟。
5. **不照搬 claude-mem hooks 插件模型**：Cerebrate 是多 agent 服务端，不是 Claude Code 单机插件。

## 4. 遗留问题

1. **Phase 5（项目目录 CLAUDE.md 生成）未实施**：需用户确认写入位置策略（根目录 vs 子目录）。
2. **knowledge.py 未接入 FTS5**：swarm 已接入；知识库全文检索可后续对齐（复用 `core/fulltext.py`）。
3. **MCP 旧工具保留为 deprecated 别名**：propose_skill/propose_lesson/knowledge_search/query；
   待调用方迁移后可移除。
4. **FTS5 需对历史记忆执行一次 `fulltext rebuild`**：新写入自动双写，旧记忆靠重建补齐。

## 5. 下一步建议

1. 提交 v5.3（git add -A && commit）
2. 部署后执行 `python3 cerebrate.py fulltext rebuild` 补齐旧记忆索引
3. 观察 MCP 调用：确认 agent 走 search→timeline→detail 工作流，token 消耗下降
4. 如启用 LLM 增强：设置 `CEREBRATE_TITLE_COMPRESS_ENABLED=true`（注意写路径 +1 次 LLM 调用）
5. 可选：Phase 5 目录上下文（需用户确认）

## 6. 关键文件与命令索引

```
cerebrate/core/fulltext.py      # FTS5 全文索引（新）
cerebrate/memory/swarm.py       # 索引层/结构化字段/token_estimate/FTS 双写
cerebrate/server/api.py         # search/timeline/memory_detail/rebuild_fulltext
cerebrate/server/http.py        # 新路由
cerebrate/brain/events.py       # EventLog.list_recent（timeline 数据源）
cerebrate/brain/llm.py          # compress_title / extract_facts_concepts
cerebrate/mcp.py                # 3 层工作流工具 + deprecated 标记
cerebrate/config.py             # fulltext_enabled / title_compress_enabled / structured_enrich_enabled

# 测试
CEREBRATE_DOCKER_SKIP_CHECK=1 python3 -m pytest tests/test_progressive_disclosure.py tests/test_structured_fields.py tests/test_fulltext.py tests/test_mcp_workflow.py -q
# 全量（13 个基线失败除外）
CEREBRATE_DOCKER_SKIP_CHECK=1 python3 -m pytest tests/ -q --ignore=tests/prod_test.py

# 服务端
python3 cerebrate.py serve --host 127.0.0.1 --port 8765
# CLI
python3 cerebrate.py search "NPM_CONFIG_TIMEOUT" --mode fts
python3 cerebrate.py timeline --anchor <id>
python3 cerebrate.py fulltext rebuild
```

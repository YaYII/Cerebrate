# Cerebrate v5.4 交接文档 — 全量测试清零 + knowledge FTS5 + sense 紧凑索引

> 交接日期：2026-08-03
> 交接人：AI 工程师（v5.4 收尾）
> 上游文档：`docs/HANDOFF_V5_3.md`（v5.3 交接）、`docs/DESIGN_OPTIMIZATION_V5_3.md`（设计）、`docs/MEMORY_SCOPE_UPGRADE.md`（v5.2）

---

## 1. 任务背景与需求

v5.3 交接时遗留：13 个失败测试（当时判定为"环境/旧测试问题"）+ knowledge 未接入 FTS5 +
Phase 5 未实施 + 4 个提交未推送。用户授权 AI 工程师独立判断并完成全部项目。

**本次结论**：13 个失败经逐一取证，**全部可修复**（2 个真实 bug + 2 个测试环境 +
9 个过时测试），并非不可解决的"环境问题"。

## 2. 已完成内容（git: 提交后见 HEAD~1..HEAD）

| 类别 | 内容 | 关键文件 |
|---|---|---|
| 真实 bug | `_item_to_dict` 把 origin_ids/supersedes 字符串逐字符拆开（导致来源追溯失效） | swarm.py |
| 真实 bug | node CLI `jsonReq` 未设 Content-Length → chunked 编码 → Python http.server 读不到 body → 400 | clients/node/src/index.ts（需重新 build） |
| 测试环境 | HTTP 测试 subprocess 未传 `CEREBRATE_MEMORY_MIN_TOKENS=0` → 短内容被拒 | tests/test_http_brain_server.py |
| 过时测试 | DocStoreFormatTests 6 个断言旧扁平目录 → 更新为 `{type}/content/{id}.md` 新结构 | tests/test_self_check.py |
| 过时测试 | EmbeddingSummaryTests 断言"ChromaDB 存摘要" → 更新为验证长文档分块父条目不存全文 | tests/test_self_check.py |
| 过时测试 | origin 进化测试调用已删除的 `_deduplicate_semantic` → 改为 `_cluster_semantic` | tests/test_origin_log.py |
| 过时测试 | `find_spec("memory.semantic")` 对不存在包抛异常 → try/except | tests/test_memory_vector_kernel.py |
| 功能补全 | **knowledge.py 接入 FTS5**：独立 `knowledge_fulltext.sqlite3` + `knowledge_` 表前缀；store/verify/deprecate/update 双写；`fulltext_query`；`rebuild_fulltext` | knowledge.py / fulltext.py / manager.py |
| 功能补全 | **`FullTextIndex` 支持 `table_prefix`**（memories/knowledge 隔离） + `recent()` 方法 | fulltext.py |
| 功能补全 | **Phase 5 第 1 项**：`/v1/sense` 返回 `recent_index`（最近记忆紧凑索引，含 token 成本） | mind.py / swarm.py |
| 功能补全 | **Phase 5 第 2 项**：项目级上下文 `POST /v1/project/context`（build/read/list）；写入 `{memory_root}/context/{project_id}.md`，`<cerebrate-context>` 标签包裹，绝不写用户项目目录 | 新增 tools/project_context.py / api.py / http.py / cli.py / mcp.py |
| 文档 | MANUAL.md 记录 knowledge FTS + recent_index | MANUAL.md |
| 部署 | 新增 `scripts/deploy.sh`（node build → 测试 → 启动 → FTS rebuild → 冒烟）；DEPLOY.md 补 v5.4 升级章节 | scripts/deploy.sh / DEPLOY.md |
| 部署 | **切换为 Docker 目标部署**：Dockerfile 修正模型为 bge-small-zh-v1.5（与 compose/现有数据 512 维一致，防止 mismatch 清空）；deploy.sh 默认 Docker 模式 | Dockerfile / docker-entrypoint.sh / deploy.sh / DEPLOY.md |
| 记忆接入 | **Claude Code SessionStart hooks**：会话开始自动注入 Cerebrate 记忆概览（health/统计/最近 8 条 + token 成本）到 AI 上下文（用户级 ~/.claude/settings.json，已备份） | ~/.claude/settings.json（用户级，不提交 git） |
| 记忆契约 | AGENTS.md + CLAUDE.md 新增「记忆使用契约」：任务开始先查记忆（证据收集）、搜索必传 project_id、完成后主动 propose | AGENTS.md / CLAUDE.md |

### 验证证据
- **全量测试：178 passed / 0 failed**（基线 161/13，清零）
- 新增测试：`test_knowledge_fulltext.py`(3) + `test_progressive_disclosure.py` sense recent_index(1)
- 新增测试：`test_project_context.py`(2)
- node CLI 修复后 `tests/test_http_brain_server.py` 8 passed（含真实服务器 E2E）
- Docker 切换实测：容器 embedding_mode=bge（512 维一致）、702 记忆完整无清空、
  容器内 rebuild 387 条 0 失败、project-context/search 全通
- hooks 实测：SessionStart 命令输出正确（708 条记忆 + 最近 8 条概览 + token 成本）

## 3. 关键决策与理由

1. **13 个失败全部修复而非"接受基线"**：逐一取证证明 2 个是真实 bug
   （swarm origin_ids、node Content-Length），修复后测试天然通过；其余是过时断言。
2. **knowledge FTS 用独立 db 文件 + 表前缀**：不与 swarm 混库，`FullTextIndex`
   加 `table_prefix` 参数（默认 memories，向后兼容）；`/v1/fulltext/rebuild`
   现在同时重建 swarm + knowledge，返回结构含 `swarm`/`knowledge` 子结果。
3. **Phase 5 两项都实施，但第 2 项采用安全策略**：
   - sense recent_index 是纯读取增强、零风险、收益明确（会话开始即见存在+成本）
   - 项目上下文**不生成到用户项目目录**（claude-mem 的 Folder Context 是单机场景，
     且 Cerebrate 无 project_id→目录映射），而是写入服务端
     `{memory_root}/context/{project_id}.md`，`<cerebrate-context>` 标签包裹，
     原子写防半成品；对外暴露 CLI `project-context` + MCP `cerebrate_project_context`
4. **MCP deprecated 别名保留**：调用方（Claude Code 客户端）迁移状态未确认，
   移除风险 > token 收益，按决策权重（稳定性优先）保留。

## 4. 遗留问题

1. **node CLI 需重新 build**：`cd clients/node && npm run build`（dist 被 gitignore，
   部署时构建）；否则 Content-Length 修复不生效。
2. **生产部署后执行 `fulltext rebuild`**：补齐旧记忆 + 旧知识库的 FTS 索引
   （新写入已自动双写）。
3. **MCP 旧工具**（cerebrate_query/propose_skill/propose_lesson/knowledge_search）：
   仍为 deprecated 别名，待确认调用方迁移后移除。
5. **PostgreSQL metastore 无独立 scope 列**：scope 在 metadata JSONB，SQL 过滤需加列。

### 已解决（2026-08-03 晚）

- **部署方式切换 Docker**（用户确认 Docker 为目标方式）：容器已重建并运行，
  数据目录 `CEREBRATE_DATA_DIR` 未变（`/home/as-workstation01/cerebrate-data`），
  宿主机裸跑服务已停止，8765 端口由容器独占。
- **AI 默认读记忆**（用户诉求：MCP 是"拉取式"需主动调用，改为 hooks 注入 +
  指令契约）：SessionStart 自动注入记忆概览；AGENTS.md/CLAUDE.md 记忆契约
  强制"开工前先查记忆"；MCP 保留为精确检索/写入通道。

### 遗留 / 注意

- **hooks 对新会话生效**：正在运行的 Claude Code 会话需重启才加载新 hooks。
- **claude-mem 插件仍 enabled 但 server 未运行**（37700 无监听）：若启动
  claude-mem server，会与 Cerebrate hooks 双份注入记忆，需用户决策用哪套。
- 用户级 settings.json 改动不提交 git（备份 ~/.claude/settings.json.bak-20260803-130255）。

### 决策记录（2026-08-03，用户确认）

- **记忆系统二选一 → 选 Cerebrate**（团队多 agent 服务端，符合架构）；
  claude-mem **保持停用**（不启动其 server，enabledPlugins 不动以免影响
  verification-platform 项目的既有配置）。
- hooks 注入内容已优化：统计行 + 最近 8 条概览 + `[记忆契约]` 引导行
  （任务开始先 search 必传 project_id；完成后主动 propose）。
- 备份：`~/.claude/settings.json.bak-20260803-130255`（首版）、
  `~/.claude/settings.json.bak-20260803-1328xx`（优化版）。

## 5. 下一步建议

1. `git push`（v5.3 的 4 个提交 + v5.4 本次提交）
2. 部署前 `cd clients/node && npm run build`，部署后 `python3 cerebrate.py fulltext rebuild`
3. 观察 sense.recent_index 与 knowledge FTS 在真实数据的表现
4. 可选：MCP 旧工具移除（需调用方确认）

## 6. 关键文件与命令索引

```
cerebrate/core/fulltext.py      # table_prefix 支持 + recent()（v5.4）
cerebrate/memory/knowledge.py   # FTS 双写/查询/rebuild（v5.4 补全）
cerebrate/memory/manager.py     # rebuild 合并 swarm+knowledge
cerebrate/brain/mind.py         # sense.recent_index（Phase 5 第 1 项）
cerebrate/memory/swarm.py       # origin_ids 修复 + recent_index
cerebrate/tools/project_context.py  # 项目上下文生成（Phase 5 第 2 项）
clients/node/src/index.ts       # Content-Length 修复（需重新 build）

# 测试
CEREBRATE_DOCKER_SKIP_CHECK=1 python3 -m pytest tests/ -q --ignore=tests/prod_test.py
# 期望：178 passed / 0 failed

# 服务端
python3 cerebrate.py serve --host 127.0.0.1 --port 8765
# 重建 FTS（含 knowledge）
python3 cerebrate.py fulltext rebuild
# 项目上下文
python3 cerebrate.py project-context --project my-project
python3 cerebrate.py project-context --project my-project --action read

# 一键部署/升级
./scripts/deploy.sh            # 完整
./scripts/deploy.sh --skip-tests --no-pull   # 快速（当前代码）
```

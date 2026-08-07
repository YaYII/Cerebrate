# 交接文档：Cerebrate 全量代码审查（2026-08-07）

> 目标：派子代理熟悉 Cerebrate 每个功能模块 → 跨模块冗余分析 → 回答「腾讯项目删了没有」+「腾讯团队记忆功能与 Cerebrate 对比」。
> 方法：5 个子代理并行只读审查（server/brain、memory、core、client/tools/mcp、腾讯项目），关键结论由主代理逐条实证复核。
> 状态：本次为只读审查，**未修改任何代码、未删除腾讯项目**（需用户确认后再执行清理）。

---

## 1. 任务背景与需求

- 用户要求：重新检查 Cerebrate 项目，派大量子代理熟悉每个功能 → 代码审查防冗余。
- 用户疑问 1：之前下载的腾讯项目（TencentDB-Agent-Memory）删掉了没有？→ **答案：没有删**，仍在 `/home/as-workstation01/Documents/project/TencentDB-Agent-Memory/`（75MB，git 分支 `feat/server_team`，克隆时间 2026-08-07 11:46）。
- 用户疑问 2：腾讯项目「和我们相同的团队记忆功能」对比。

## 2. 已完成内容

### 2.1 子代理分工
| 子代理 | 审查范围 | 关键产出 |
|---|---|---|
| Franklin | `server/` + `brain/` + `migrate.py` + `protocol.py`（6630 行） | 发现 NameError 功能失效、migrate 不可达、list_all_knowledge 双定义 |
| Kepler | `memory/`（4893 行） | 19 处死代码、7 处重复实现、update_metadata 幽灵调用 |
| Meitner | `core/` + `entity.py` + `config.py`（1839 行） | 15 个死/重复配置字段、token 估算三处并存 |
| Epicurus | `client/` + `mcp.py` + `tools/` + `mcp.js`（~4600 行） | 四套 HTTP 客户端、MCP 三套实现 43/43/39 漂移 |
| Zeno | 腾讯项目（175,544 行 TS） | 团队记忆功能 5 核心文件 + 与 Cerebrate 对比维度表 |

### 2.2 已实证确认的关键缺陷（主代理逐条复核）

#### P0：功能失效（非冗余，是 bug）
1. **自动经验提取永远失败（NameError）**：`api.py:1501` `title = lesson.get(...)` 在 `lesson` 定义（1516 行）之前执行 → 任何带 problem 的 usage 必抛 `NameError`，外层 try/except 吞掉 → 「人人为我」自动提取实际从未成功。测试未覆盖此路径。
2. **Skill 版本化 PG 同步静默失效**：`swarm.py:1629` 调用 `self._ms.update_metadata(memory_id, updates)`，但 `metastore.py` 无此方法（只有 `update_lifecycle`）→ 被 try/except: pass 吞掉 → PG 侧 skill 版本永不更新。
3. **`cerebrate.py migrate` 命令不可达**：`server/cli.py:33` `from migrate import migrate_all` 是顶层模块名（应为 `cerebrate.migrate`）→ 实测 `ModuleNotFoundError`。

#### P1：确定性冗余（建议清理）
4. **`list_all_knowledge` 同文件双定义**：`api.py:2622`（摘要版）被 `api.py:2942`（完整版）覆盖，前者是死方法。
5. **版本号漂移**：`manager.py:301` 硬编码 `"version": "5.1.2"`，而 `VERSION` = `cerebrate-mcp-v5.2.1` → `/v1/sense` 对外报旧版本。
6. **死代码（~20 处）**：`mind.think/evolve`、`logger.read_by_module/read_by_level`、`events.count`、`stop_scheduler`、`agents.unregister/is_registered`、`personal.get_language/get_name/forget/remember_project_pref`（死链）、`manager.fulltext_query_knowledge/get_policy/verify_knowledge/deprecate_knowledge/list_agents/get_query_log`（写而不读）、`scene.update_meta/get_mmd`、`origin.list_ids`、`docstore.get_content/get_metadata/exists/get_available_ids`（仅测试用）、`docstore.CONTENT_KEY/FULL_CONTENT_KEY`（内部都没用）、`swarm.load_memory_raw`。
7. **15 个死/重复配置字段**：`use_chroma`、`evolution_enabled`（.env 已设但 0 引用！）、`reranker_top_k`、`swarm_enabled`、`project_root`、`server_url`、`current_project_name`、`fulltext_path`、`code_repos_path`、`database_url`+`pg_*`（metastore 绕开 config 直接读 env）。
8. **token 估算三处并存**：`chunking.estimate_tokens`（加权公式）vs `swarm.estimate_tokens`（len//4）vs `fulltext.py` 内联（len//4）→ 口径不一致。
9. **MCP 工具清单三处漂移**：`mcp_transport.py` 39 个 / `mcp.py` 43 个 / `mcp.js` 43 个；服务端缺 `auth_logout/propose_lesson/propose_skill/register` 4 个。
10. **CLI 死参数**：`cmd_stats` 与 `cmd_sense` 完全等价（都是 GET /v1/sense）；`ingest --scope` 解析但未生效；`recall --user` 被忽略；`mcp.py _SERVER_TOKEN` 死变量；多处无用 import（rewriter.random、scheduler.datetime、mind.Path 等）。
11. **红线冲突**：CLI `project-harvest --dir` 仍走服务端扫描（代码上传服务端），与「代码不离开本地」架构红线相悖；推荐路径是 `harvest-push`。

### 2.3 规模盘点
- Cerebrate 代码：49 个 py，17,899 行（api.py 2978 行为最大，swarm.py 1767 次之）。
- 测试：39 个测试文件，健康。
- `docs/archive/` 4 个历史脚本（curate/evolve_full/migrate_docstore*）已在 HANDOFF_DISTILL_VOTE 标记废弃（curate 被 curate_v3.py 替代）——可留可清。
- `clients/node/` 是独立 TS HTTP 客户端 SDK（非冗余）；`node_modules` 已 gitignore。

## 3. 腾讯项目 vs Cerebrate 团队记忆功能对比

腾讯 `TencentDB-Agent-Memory`（175,544 行 TS，4+1 组件：MemoryCore 8420 / MemoryKnowledge 8421 / MemoryPanel 8125 / MemoryProxy 8096 + SDK）的团队记忆核心：

| 维度 | 腾讯 TencentDB-Agent-Memory | Cerebrate |
|---|---|---|
| 团队模型 | User/Team/Agent/Task 组织结构 + 角色（admin/member/reviewer） | 无组织结构；scope(project)+project_id 平面隔离 |
| 资产装配 | Asset 统一注册 + Fixed Binding（agent↔asset 显式装配，Loadout 概念） | Loadout 装配（v5.2 已借鉴实现） |
| 权限 | owner→member→visibility(5 档)→role→ACL(3 主体) 三段式 | 无实体级 ACL |
| 隔离 | 五维租户（team/user/agent/session/task） | scope(general/project)+project_id |
| 运行时注入 | MemoryProxy 拦截 LLM 请求，每轮注入 + 借入 ≤2 队友记忆 | SessionStart hooks 注入 + MCP 主动检索 |
| 生命周期 | L0→L1→L2→L3 蒸馏 + Skill 版本化/评审 | evolution 蒸馏 + nutrient→memory 共识 + Skill 版本化（已借鉴） |
| 检索 | BM25+向量+RRF，TCVDB 短路 | FTS5+向量+RRF（v5.1 已借鉴）+ 渐进式披露 |

**结论**：Cerebrate 已把腾讯最有价值的 4 个机制吸收完毕（RRF 融合检索、Skill 结构化资产+版本化、Loadout 装配、场景蒸馏）。腾讯剩余可借鉴点：**实体级 ACL 权限模型**（目前 Cerebrate 无）与 **MemoryProxy 运行时注入**（Cerebrate 用 SessionStart hooks 等效实现，无需引入代理层）。

## 4. 关键决策与理由
- 本次只读不删改：按用户偏好「清理类操作先查根因、给建议、确认后再执行」。
- 腾讯项目**建议删除**（75MB 参考代码已完成使命，借鉴点已全部落地）或归档到非工作目录；由用户决定。

## 5. 遗留问题
- P0 三项 bug 未修复（需授权）。
- P1 冗余清理未执行（需授权）。
- `distill_knowledge_on_demand`（同步）vs `_run_distill`（异步）两套蒸馏并存，建议评估合并。

## 6. 下一步建议
1. 先修 3 个 P0 bug（改一行/几行，无回归风险）：NameError 调序、`cerebrate.migrate` 导入路径、`update_metadata` 改为 `put_document` 或删除。
2. 清理 P1 死代码（参考历史 git 5938faa 的 A/B/C 分级方法，全量回归 233+ 用例）。
3. 修版本号漂移（manager.py → 读 VERSION）。
4. 统一 token 估算。
5. 决定腾讯项目去留。

## 7. 关键文件与命令索引
- 审查范围：`cerebrate/server/`、`cerebrate/brain/`、`cerebrate/memory/`、`cerebrate/core/`、`cerebrate/client/`、`cerebrate/tools/`、`cerebrate/mcp.py`、`mcp.js`
- 关键证据位置：`api.py:1501/2622/2942`、`swarm.py:1629`、`manager.py:301`、`server/cli.py:33`、`config.py:78-248`
- 回归测试：`python3 -m pytest tests/ -x -q` 或 `scripts/run_regression.sh`
- 腾讯项目：`/home/as-workstation01/Documents/project/TencentDB-Agent-Memory/`

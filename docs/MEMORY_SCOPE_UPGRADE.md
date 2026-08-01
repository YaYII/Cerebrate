# 记忆分类升级 — 通用记忆 vs 项目记忆（scope）

> 完成日期：2026-08-01
> 版本：Cerebrate v5.1 → v5.2（记忆分类）

## 1. 任务背景与需求

**为什么做**：原来的记忆过于"通用"。所有记忆和经验都有特定背景，很多不能跨项目复用，
不能依赖经验主义。但旧系统里"通用记忆"查询会混入项目记忆，导致跨项目污染。

**要什么结果**：
- 通用记忆查询**只返回通用记忆，绝不混入项目记忆**
- 项目记忆查询返回**该项目记忆 + 通用记忆**（项目记忆可包含通用记忆）
- 记忆写入自动推导分类，也可显式指定

## 2. 已完成内容

### 2.1 新增 `scope` 分类字段（核心）

每条记忆/知识文档现在带 `scope` 字段，取值：

| scope | 含义 | 查询可见范围 |
|---|---|---|
| `general` | 通用记忆（跨项目） | 只返回通用记忆 |
| `project` | 项目记忆 | 该项目记忆 + 通用记忆 |
| `all` | 跨项目全量 | 进化/管理专用，不做隔离 |

**写入自动推导规则**（`swarm.share` / `knowledge.store`）：
- 未传 scope：`project_id` 非空 → `scope=project`；`project_id` 空 → `scope=general`
- 显式 `scope=general`：强制通用，忽略 project_id
- 显式 `scope=project`：project_id 缺失时用 `CEREBRATE_PROJECT_ID`；仍无则降级 general

**查询规则**（`swarm.query` / `knowledge.lookup`）：
- 不传 project_id 和 scope → 只查通用记忆（关键行为变化！）
- 传 project_id → 项目 + 通用（旧行为兼容）
- `scope=general` → 强制只查通用
- `scope=project` → 项目 + 通用
- `scope=all` → 跨项目全量

### 2.2 修改文件清单

| 文件 | 改动 |
|---|---|
| `cerebrate/memory/swarm.py` | share/query/_build_metadata/聚合/`_item_to_dict` 支持 scope；`scope_counts()` 统计 |
| `cerebrate/memory/knowledge.py` | store/lookup 支持 scope |
| `cerebrate/memory/manager.py` | share_to_swarm/query_swarm/store_knowledge/lookup_knowledge 透传 scope |
| `cerebrate/server/api.py` | query/propose 读取 scope；sense 展示 memory_scope 统计 |
| `cerebrate/server/http.py` | /v1/knowledge 支持 scope 参数 |
| `cerebrate/client/cli.py` | query/propose 增加 `--scope` 参数 |
| `cerebrate/mcp.py` | cerebrate_query/propose/knowledge_search 支持 scope |
| `cerebrate/tools/ingest.py` | ingest 支持 `--scope` |
| `cerebrate/brain/decision.py` | DecisionRouter 透传 scope |
| `cerebrate/brain/mind.py` | sense 输出 memory_scope；项目健康度区分通用/项目 |
| `cerebrate/memory/evolution.py` | 跨项目蒸馏/教条查询显式 `scope=all`（防止被通用过滤误伤） |
| `tests/test_memory_scope.py` | 新增 11 个 scope 隔离测试 |
| `MANUAL.md` | 新增记忆分类章节 |

### 2.3 验证证据

```text
tests/test_memory_scope.py   → 11 passed
tests/test_decision_router.py → 1 passed
tests/test_server_brain_requirements.py → 5 passed
E2E 实测：
  - 通用查询只返回 scope=general 记忆 ✅
  - 项目 A 查询返回 [项目A记忆, 通用记忆] ✅
  - sense.memory_scope = {"general": 1, "project": 2, "by_project": {...}} ✅
```

全量测试：132 passed / 13 failed，13 个失败全部为**基线已存在的环境/旧测试问题**
（DocStore 旧扁平目录测试、node CLI 编译产物缺失、Docker 容器拦截、origin API 依赖），
本次改动引入 0 个新回归。

## 3. 关键决策与理由

1. **用 `scope` 字段而非只依赖 project_id 空/非空**：显式分类字段语义清晰，可独立于
   `CEREBRATE_PROJECT_ID` 默认值表达"这是一条通用记忆"，避免默认项目设置污染通用记忆。
2. **默认查询只返回通用记忆**：这是需求核心（"通用记忆只有通用记忆，不含项目记忆"），
   属于有意的行为变更。旧调用方若需项目记忆必须显式传 project_id/scope。
3. **`scope=all` 专供进化/管理**：evolution 蒸馏与教条生成需要跨项目全量记忆，
   显式 `scope=all` 防止被默认通用过滤误伤。
4. **旧数据兼容**：无 `scope` 字段的旧记忆在读取时按 project_id 推导
   （`meta.get("scope", "project" if project_id else "general")`），无需数据迁移。

## 4. 遗留问题

1. **测试基线问题**（非本次引入）：`tests/test_self_check.py` 的 DocStoreFormatTests
   仍按旧扁平目录格式断言（`storage_path / "{id}.md"`），与新版子目录结构
   （`{type}/content/{id}.md`）不符，7 个测试需更新。
2. `tests/test_http_brain_server.py` 需要 node CLI 编译产物与无 Docker 容器环境才能全绿。
3. **PostgreSQL metastore**：`documents` 表没有独立的 `scope` 列，scope 存在
   `metadata` JSONB 中。若需按 scope 做 SQL 过滤，需后续加列。

## 5. 下一步建议

1. 更新 `tests/test_self_check.py` 的 DocStoreFormatTests 到新版子目录结构。
2. 在客户端接入文档（MCP / CLAUDE.md）中强调：**涉及项目上下文时必须传 project_id**，
   否则默认只能查到通用记忆。
3. 可考虑为 `scope` 增加数据迁移/回填工具（当前按需推导已够用）。

## 6. 关键文件与命令索引

```bash
# 运行 scope 测试
python3 -m pytest tests/test_memory_scope.py -v

# 运行决策路由测试
python3 -m pytest tests/test_decision_router.py -v

# 完整测试（排除需要真实服务器的 prod_test）
CEREBRATE_DOCKER_SKIP_CHECK=1 python3 -m pytest tests/ -q --ignore=tests/prod_test.py

# 手动验证（本地临时服务器）
python3 cerebrate.py query "通用问题" --url http://127.0.0.1:8765
python3 cerebrate.py query "项目问题" --url http://127.0.0.1:8765 --project proj-a --scope project
python3 cerebrate.py propose --title "通用经验" --content "..." --scope general
python3 cerebrate.py propose --title "项目经验" --content "..." --project proj-a

# 查看记忆分类统计
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/sense
```

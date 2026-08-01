# Cerebrate v5.3 优化设计方案 — 吸收 claude-mem 设计优点

> 完成日期：2026-08-01
> 作者：Cerebrate 项目设计师（AI）
> 状态：v5.2 已发布；v5.3 设计方案已按 Phase 1-4 实施并验证（见文末「实施记录」）
> 基线：v5.2（记忆分类 scope 升级，见 `docs/MEMORY_SCOPE_UPGRADE.md`）
> 参考：claude-mem（https://github.com/thedotmack/claude-mem）
>      官方文档：search-architecture / progressive-disclosure / architecture-evolution / folder-context

---

## 1. 设计目标

Cerebrate 记忆分类（通用/项目隔离）已完成。本方案回答下一个问题：
**如果我是这个项目的设计师，我会如何优化 Cerebrate？**

优化原则（继承 AGENTS.md 决策权重）：

```
稳定性 > 成功率 > 安全性 > 可复现性 > 改动范围 > 耗时
```

核心设计取向：**不推翻现有架构**（服务端 + ChromaDB + DocStore + MCP 仍保留），
而是把 claude-mem 验证过的三个设计哲学注入现有系统：

1. **渐进式披露（Progressive Disclosure）**：先给索引，让 agent 决定取什么
2. **检索成本可见（Cost Visibility）**：索引里直接标 token 成本
3. **工具即工作流（Tool Design Enforces Workflow）**：精简 MCP 工具，让浪费 token 在结构上变难

---

## 2. 现状诊断（证据）

### 2.1 已完成：v5.2 记忆分类（scope）

- `scope` 字段（general / project / all）写入自动推导、查询隔离
- `tests/test_memory_scope.py` 11 passed；E2E 验证通过
- 待提交 git（12 个文件 M + 1 新文件 + 文档）

### 2.2 当前检索链路的问题（重构前证据）

| 问题 | 证据 | 影响 |
|---|---|---|
| **查询返回全量内容** | `swarm.query()` 对所有匹配调用 `_enrich_from_docstore()`（swarm.py:371）+ 上下文扩展；`/v1/query` 把 `best` + `related` 全部放入 `swarm_results` | 每次查询返回多条完整记忆，token 消耗高，且把"判断相关性"的责任压在一次性加载上 |
| **MCP 工具多且重叠** | 当前 19 个工具：`query / recall / remember / knowledge_search` 都是读；`propose / propose_skill / propose_lesson / knowledge_store` 都是写 | 工具定义占上下文、无工作流引导、agent 不知道该用哪个 |
| **无全文检索（FTS）** | 检索只有 ChromaDB 向量 + `find_by_title` LIKE | 精确关键词（错误码、命令、函数名）召回弱；LIKE 慢 |
| **无索引层** | 没有"只返回 id/标题/类型/成本"的紧凑接口 | 无法先扫描再决定取什么 |
| **无 timeline 概念** | EventLog（brain/events.py）有按序事件流，但未暴露为"围绕某记忆的时序上下文" | agent 无法理解"这个方案的前因后果" |
| **无 token 成本展示** | 检索结果无 `token_estimate` 字段 | agent 无法做"取不取"的成本决策 |
| **无语义压缩标题约束** | title 由提交者自由填写 | 标题不可靠，就无法在索引层做判断 |

### 2.3 Cerebrate 现有可复用的资产

- **EventLog**（brain/events.py）：append-only 事件流，含 `memory.proposed / memory.queried / usage` 事件 → **timeline 层可以直接建立在它之上**
- **GET /v1/memories/{id}**：已存在 → 可作为 detail 层
- **DocStore**（{id}.md + {id}.json）：内容与元数据分离 → 索引层天然轻量
- **scope 隔离**：索引层直接继承，项目记忆/通用记忆在每一层都隔离
- **consensus / doctrine / evolution**：Cerebrate 独有的群体决策，不需要学 claude-mem（它是单机单用户）

---

## 3. claude-mem 设计优点（证据）

### 3.1 渐进式披露 3 层工作流（最核心）

claude-mem 官方数据（progressive-disclosure 文档）：

```
传统 RAG：抓 20 条 → 10,000-20,000 tokens → 只有 ~10% 相关
3 层工作流：
  第1层 search（索引）           ~1,000-2,000 tokens
  第2层 timeline（时序上下文）   按需
  第3层 get_observations（详情） 只取筛选后的 3 条 ~1,500-3,000 tokens
  合计 2,500-5,000 tokens → 节省 50-75%
```

索引行格式（每条约 50-100 tokens）：

```
| ID    | Time | T  | Title                                   | Tokens |
| #2543 | 2:14PM | 🔴 | Hook timeout: 60s too short for npm install | ~155 |
```

关键设计原则：
- **先展示存在与其检索成本，让 agent 决定取什么**
- **让成本可见**：每条索引都标 ~token 数，agent 能做 ROI 决策
- **语义压缩**：好标题 = 系统成败关键（标题不好，索引层就无法判断）
- **工具设计强制工作流**：`important_workflow` 工具始终可见；无法跳过索引直接取详情

### 3.2 MCP 工具精简（9 → 4）

```
精简前：9 个重叠工具（search_observations / find_by_type / find_by_file / ...）
        ~2,500 tokens 工具定义 / ~2,718 行代码
精简后：4 个工具（important_workflow / search / timeline / get_observations）
        ~312 行代码，schema 用 additionalProperties:true
```

洞察："进步式披露从 agent 必须记住的事，变成工具设计本身强制的事"。

### 3.3 FTS5 全文搜索

- SQLite FTS5 虚拟表 + trigger 同步，sub-10ms
- 查询注入转义（332 个注入测试）
- 与 Chroma 向量混合检索，FTS5 失败时降级可用
- 补足向量检索的精确匹配短板（错误码、命令、函数名）

### 3.4 结构化 observation 字段

```
title / subtitle / narrative / text / facts / concepts / files_read / files_modified / type
type: decision | bugfix | feature | refactor | discovery | change
```

### 3.5 Folder Context（目录级 CLAUDE.md）

- 自动在项目子目录生成 CLAUDE.md，`<claude-mem-context>` 标签包裹自动内容
- **项目根目录（含 .git）排除**——避免覆盖手写根 CLAUDE.md
- 与 Cerebrate 的"项目记忆"概念同构：记忆必须绑定背景（目录/项目）

### 3.6 架构演进教训（v1 → v5）

- v1-v2 全量倾倒 → 上下文污染（35,000 tokens 加载，相关仅 ~500）
- v4 progressive disclosure + 结构化字段 → 上下文使用 -96%
- v5 混合搜索（FTS5 + Chroma）降级可用
- **AI 即压缩器**：手动规则无法匹配语义压缩，AI 压缩 10:1-100:1

---

## 4. 适配分析：什么能吸收、什么不能照搬

| claude-mem 设计 | 能否吸收到 Cerebrate | 理由 |
|---|---|---|
| 3 层渐进式披露检索 | ✅ 吸收（Phase 1） | 核心哲学，与架构无关 |
| 索引显示 token 成本 | ✅ 吸收（Phase 1/4） | 纯展示层增强 |
| 工具精简 + 工作流强制 | ✅ 吸收（Phase 2） | MCP 层重构，不动内核 |
| FTS5 全文搜索 | ✅ 吸收（Phase 3） | Python stdlib sqlite3 即可，零新依赖 |
| 结构化 observation 字段 | ✅ 部分吸收（Phase 4） | Cerebrate 已有 problem/solution/evidence，补齐 type/facts/concepts |
| 语义压缩标题 | ✅ 吸收（Phase 4） | 已有 LLM 免疫层可复用，rule-only 保底 |
| 5 个生命周期 Hooks | ❌ 不照搬 | Cerebrate 是多 agent 服务端，不是 Claude Code 单机插件 |
| Folder Context（生成 CLAUDE.md） | ⚠️ 受控吸收（Phase 5 可选） | 需确认写入位置与防覆盖策略 |
| Worker 独立进程 | ❌ 不照搬 | Cerebrate 已是常驻服务端 |
| observation 数字 ID | ⚠️ 不强制 | Cerebrate 用字符串 memory_id，保留 |

---

## 5. 分阶段优化方案

### Phase 1：渐进式披露 3 层检索（核心，建议先做）

**做什么**：

1. `swarm.query()` 增加 `index_only` 参数：跳过 `_enrich_from_docstore` 与上下文扩展，
   每条结果只返回 `memory_id / title / category / scope / life_stage / created / score / token_estimate`
2. 服务端新增：
   - `POST /v1/search` → 紧凑索引（index 层）
   - `POST /v1/timeline` → 围绕 anchor memory_id 的时序上下文（基于 EventLog + DocStore）
   - `GET /v1/memories/{id}` 已存在 → 即 detail 层
3. `POST /v1/query` 行为微调（向后兼容）：
   - 默认返回索引 + recommendation + task（不含全文）
   - `detail=true` 时才返回全文（旧行为）
4. `token_estimate` 计算：`len(content) // 4`（写入时存 meta，查询时直接用）

**改动文件**：`swarm.py`、`server/api.py`、`server/http.py`、`client/cli.py`

**风险**：低（新增接口 + 参数兼容，不改旧行为）

**收益**：查询 token 消耗预计降低 50-75%（对齐 claude-mem 数据）

### Phase 2：MCP 工具精简（19 → 工作流化）

**做什么**：

读侧收敛为 3 层工作流：

| 新工具 | 替代 | 说明 |
|---|---|---|
| `cerebrate_search` | query / recall / knowledge_search | 索引层 |
| `cerebrate_timeline` | （新增） | 上下文层 |
| `cerebrate_detail` | memory-get / （新增批量） | 详情层，支持 ids 批量 |

写侧收敛：

| 新工具 | 替代 | 说明 |
|---|---|---|
| `cerebrate_propose` | propose / propose_skill / propose_lesson | 统一写入，category/tags 自动分流 |

保留：`cerebrate_sense`（并入 help 内容，`cerebrate_sense` 返回开头加 workflow 引导）、
`cerebrate_doctrines`、`cerebrate_assess`、`cerebrate_use_start`、`cerebrate_use_finish`。

管理类保留但标记为高级：`cerebrate_vote`、`cerebrate_ingest`、`cerebrate_stats`、
`cerebrate_knowledge_store`、`cerebrate_batch_process`。

**改动文件**：`cerebrate/mcp.py`

**风险**：中（涉及工具重命名，需同步 MANUAL.md 与调用方；建议保留旧工具名作为别名过渡）

**收益**：工具定义 token 下降、工作流清晰、重叠读工具消除

### Phase 3：FTS5 全文索引（混合检索）

**做什么**：

1. 新增 `cerebrate/core/fulltext.py`：SQLite FTS5（stdlib sqlite3，零新依赖）
2. 双写：`swarm.share` / `knowledge.store` 时同步 upsert FTS（title + content + tags + scope + project_id）
3. 混合检索：FTS5 关键词命中 + ChromaDB 向量命中 → 合并去重排序
4. 重建命令：`cerebrate.py fulltext rebuild`（从 DocStore 全量重建）

**改动文件**：新增 `fulltext.py`、`swarm.py`、`knowledge.py`、`cli.py`

**风险**：中（双写一致性；需原子写 + 崩溃恢复；重建命令兜底）

**收益**：精确关键词（错误码、命令、函数名）召回大幅提升；过滤查询 sub-10ms

### Phase 4：结构化字段 + 语义压缩

**做什么**：

1. 写入时自动填充：
   - `observation_type`：由 category 映射（debugging→bugfix、architecture→decision、
     refactor→refactor、discovery→discovery、performance→optimization、security→gotcha…）
   - `facts` / `concepts`：从 content 提取（LLM 可用时 AI 提取；否则规则提取名词短语）
   - `token_estimate`
2. 标题语义压缩（可选 LLM）：propose 时若 title 过长或过于含糊，LLM 压缩为 ≤12 词；
   rule-only 保底：截断 + 保留关键词
3. 索引层展示 type 标签 + token 成本

**改动文件**：`swarm.py`、`api.py`、`mcp.py`

**风险**：低-中（写入路径增加字段，需保证旧数据兼容：缺失字段时索引层降级显示）

**收益**：索引层可判断性大幅提升（claude-mem：标题质量决定系统成败）

### Phase 5（可选）：上下文注入 + 项目目录上下文

**做什么**：

1. `cerebrate_sense` 返回"最近记忆紧凑索引"（含 token 成本），让会话开始即见
   "存在什么 + 取它要花多少"
2. 项目级 CLAUDE.md 生成（受控）：为 scope=project 的项目生成/更新浓缩版上下文文件，
   `<cerebrate-context>` 标签包裹自动内容，**绝不覆盖手动内容**；
   对齐 claude-mem Folder Context 排除根目录的策略

**改动文件**：`mcp.py`、新增 `cerebrate/tools/project_context.py`

**风险**：中（涉及文件系统写入策略，需明确防覆盖与权限）

**收益**：agent 会话启动即获得项目记忆概览

---

## 6. 优先级与决策建议

```
建议顺序：Phase 1 → Phase 4 → Phase 3 → Phase 2 → Phase 5
```

| 阶段 | 收益 | 风险 | 改动范围 | 建议 |
|---|---|---|---|---|
| Phase 1 渐进式披露 | 高（token -50-75%） | 低 | 4 文件 | ✅ 先做 |
| Phase 4 结构化+压缩 | 高（索引可判断性） | 低-中 | 3 文件 | ✅ 次之 |
| Phase 3 FTS5 | 中-高（精确召回） | 中（双写） | 4 文件+新文件 | ✅ 第三 |
| Phase 2 工具精简 | 中（工具定义 token） | 中（兼容） | 1 文件 | ⚠️ 与 1/4 同批或之后 |
| Phase 5 上下文注入 | 中 | 中（写入策略） | 2 文件 | ⚠️ 需用户确认 |

### 决策要点

1. **不推翻架构**：服务端 + ChromaDB + DocStore + MCP 全保留，只加索引层/全文层/展示层
2. **向后兼容优先**：所有新接口为新增；旧接口行为保留（`detail=true` 开关）
3. **timeline 建立在 EventLog 上**：零新存储，只加查询聚合逻辑
4. **FTS5 用 stdlib sqlite3**：零新依赖，不引入 PostgreSQL 约束（metastore 仍可选）
5. **scope 隔离贯穿每一层**：索引/详情/timeline/全文全部继承 scope 过滤，项目记忆不泄漏

---

## 7. 遗留与待办

1. **v5.2 scope 升级待提交 git**（12 文件 M + 1 新 + docs）
2. Phase 2 工具重命名需要与 MCP 客户端（mcp.json）协调
3. Phase 5 的 CLAUDE.md 生成位置需用户确认（项目根目录 or 子目录）
4. claude-mem 的 hooks 模型不适配多 agent 服务端，不采纳

---

## 8. 下一步

待用户选择实施范围后，按 Phase 顺序执行；每个 Phase 完成时跑全量测试
（基线 132 passed / 13 failed，13 个为既有环境问题）确认无新回归。

---

## 9. 实施记录（2026-08-01，v5.3）

### 已实施

| 阶段 | 内容 | 验证 |
|---|---|---|
| Phase 1 | 渐进式披露 3 层检索：`/v1/search`（索引层）、`/v1/timeline`（上下文层）、`/v1/memories/detail`（详情层批量）；`swarm.query(index_only)`；`token_estimate` 写入 | 9 测试通过 + E2E |
| Phase 4 | `observation_type`（category→type 规则映射）、`facts`/`concepts` 规则提取；LLM 语义压缩标题 + 结构化增强（`CEREBRATE_TITLE_COMPRESS_ENABLED` / `CEREBRATE_STRUCTURED_ENRICH_ENABLED` 开关，默认关） | 8 测试通过 |
| Phase 3 | FTS5 全文索引（`cerebrate/core/fulltext.py`，SQLite trigram，零新依赖）；share 双写；`/v1/search` hybrid/fts/vector 三模式；`fulltext rebuild` 命令 | 7 测试通过 + E2E |
| Phase 2 | MCP 新增 `cerebrate_search/timeline/detail`；sense 描述含 3-LAYER WORKFLOW 引导；4 个重叠工具标记 deprecated；propose 透传结构化字段 | 5 测试通过 |

### 设计调整（基于实施证据）

1. **`/v1/query` 默认行为未改变**（默认 `detail=true` 返回全文 + 决策）。
   设计稿原计划默认索引模式，但回归测试 `test_propose_long_document_through_api`
   证明该变更破坏既有契约。按"向后兼容优先"原则改为：索引层由新端点 `/v1/search`
   承担，`detail=false` 作为显式轻量模式保留。渐进式披露在工作流/工具层生效，
   而非静默改变旧接口语义。
2. **FTS5 用 trigram tokenizer**（SQLite 3.34+）：中文子串匹配优于 unicode61；
   2 字以下中文词自动走 LIKE 回退（trigram 需 3 字元）。
3. **FTS5 路径动态派生自 `memory_root`**：避免测试/多实例覆盖 memory_root 时
   写入项目真实库。

### 测试规模

全量：**161 passed / 13 failed**（13 个失败与 v5.2 基线完全一致，0 新回归）。
新增测试文件：`test_progressive_disclosure.py`(9)、`test_structured_fields.py`(8)、
`test_fulltext.py`(7)、`test_mcp_workflow.py`(5)。

### 遗留

- Phase 5（项目目录 CLAUDE.md 生成）未实施，需用户确认写入位置策略
- knowledge.py 尚未接入 FTS5（swarm 已接入），可后续对齐
- MCP 旧工具名（propose_skill/propose_lesson/knowledge_search/query）保留为 deprecated 别名

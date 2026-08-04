# 业务画像（数据世界）设计方案 v0.1（2026-08-04）

> 来源：用户认知模型（十几年工程经验总结）。本文档先评估该模型，再给出可落地的分阶段方案。
> 关联：`HANDOFF_GENERAL_MEMORY_RECLASS_20260804.md`（技术/业务归类执行记录）、v5.2 scope 隔离、v5.3 渐进式披露、v5.4 project-context。

## 0. 认知模型评估

用户提出的两个核心概念，评估如下：

### 概念一：项目记忆 = 技术层面（通用） + 业务层面（专属）
- **判断：正确**。判据是「可继承性」——技术层面可跨项目复用，业务层面无法被其他项目继承。
- **与现有系统天然契合**：`scope=general` 的记忆在所有项目查询中可见（项目查询 = 项目 + 通用）；`scope=project + project_id` 仅本项目命中。因此：
  - 技术层面 → `scope=general`（跨项目参考）
  - 业务层面 → `scope=project + project_id`（项目专属）
- **边界补充**：
  1. 真实记忆是连续谱，存在混合记忆（如「DOB 重指派 V2 槽位设计」既是 DOB 业务接口又是通用设计模式）。需容错：按主体语义归类 + 允许人工修正，不追求绝对二分。
  2. 「项目技术栈」记忆（如 ihm-backend 的 Flowable 实践）按用户标准属技术层面 → 通用；但**建议保留来源项目标签**（tags 含项目名），便于溯源与画像聚合。
  3. 可增加显式元数据 `knowledge_type=tech|business`（或复用 category/observation_type），使画像构建与检索过滤可编程化，而非依赖人工判断。

### 概念二：业务画像 = 「数据世界」（树形结构 + 依赖关系 + 数据实体）
- **判断：方向正确，是解决 AI 大面积扫代码耗 token 的正解**。
- 本质对应业界成熟实践：DDD（限界上下文/聚合/实体关系）、数据库 ER 模型、知识图谱（实体-关系）、claude-mem 的 Folder Context（v5.3 调研已对比）。
- 用户洞察「数据世界对 → 业务才对」的工程解释：**数据模型是业务的稳定锚点**——需求描述会变、代码实现会变，但核心数据实体与关系（谁依赖谁、数据从哪来到哪去）相对稳定；数据模型错了，建立其上的业务规则与代码全部失真。
- **边界补充**：
  1. 依赖关系不是严格树（是 DAG/图）：模块 A 可被 B、C 依赖，实体存在多对多。**树负责导航，边负责依赖**，两者都要建模。
  2. 业务是动态演进的（需求变动/代码调整），画像必须**版本化 + 变更记录**，否则会与代码漂移。
  3. 画像构建成本高：完全自动抽取易失真（LLM 幻觉、过时），需要「AI 初稿 + 人工确认 + 持续更新」闭环。

## 1. 目标

为每个项目提供「业务画像（数据世界）」：
- 树形/图结构：项目 → 业务域 → 数据实体 → 字段/规则，标注依赖关系与数据流向
- 每个节点挂载：业务记忆（scope=project 的记忆）、代码入口、相关文档
- 用途：AI 接手项目时先读画像（导航），再精确读取目标模块，**避免全量扫描代码消耗 token**

## 2. 数据模型（建议）

```jsonc
{
  "project_id": "ihm-backend",
  "version": 1,
  "updated_at": "2026-08-04T10:00:00+00:00",
  "domains": [                       // 业务域（树的第二层）
    {
      "id": "dob",
      "name": "DOB 房屋局技术分析",
      "description": "……",
      "entities": [                  // 数据实体（数据世界的核心）
        {
          "id": "dob_case",
          "name": "个案",
          "description": "……",
          "fields": [{"name": "case_id", "type": "string", "desc": "……"}],
          "relations": [             // 依赖/关系（图）
            {"to": "dob_assignment", "type": "1:N", "via": "case_id"}
          ],
          "code_hint": "app/Models/DobCase.php",
          "memories": ["<memory_id>", "…"]   // 业务记忆挂载
        }
      ],
      "depends_on": ["flowable"],    // 域间依赖（DAG）
      "memories": ["<memory_id>", "…"]
    }
  ],
  "shared_tech": {                   // 项目技术栈（技术层面，通用参考）
    "stack": ["Laravel", "Flowable", "MySQL"],
    "tech_memories": ["<memory_id>", "…"]   // 指向 scope=general 的技术记忆
  }
}
```

- **存储**：`{memory_root}/profiles/{project_id}.json`（机器可读）+ 渲染 `{project_id}.md`（AI 可读导航，复用 `<cerebrate-context>` 标签风格）。
- **树 = 导航**：project → domain → entity → field。
- **图 = 依赖**：entity.relations + domain.depends_on，供「改 A 影响谁」分析。

## 3. 分阶段实施

### Phase 1：画像数据模型 + API（预计 0.5-1 天）
- 新增 `cerebrate/tools/project_profile.py`：ProfileStore（JSON 读写、版本、原子写）。
- API：`POST /v1/project/profile`（build/read/update/list）+ CLI `project-profile` + MCP 工具。
- 渲染 Markdown 导航页（树形缩进 + 依赖箭头）。

### Phase 2：画像构建管线（1-2 天）
- **输入**：项目业务记忆（scope=project）+ 通用技术记忆（tech）+ 项目文档/README + （可选）代码目录结构。
- **AI 初稿**：调用 CerebrateLLM 生成树形画像（域/实体/关系），写入草稿。
- **人工确认**：`profile confirm` 或 web 页面对照修改；确认后 version+1 正式化。
- **增量更新**：新业务记忆 propose 时可带 `profile_node_id`，自动挂载；需求变动触发 rebuild 建议。

### Phase 3：导航检索（1 天）
- 新检索入口：`POST /v1/project/navigate {"project_id":"ihm-backend","target":"DOB 指派"}` →
  返回画像路径（project → domain → entity）+ 该节点挂载的业务记忆 + code_hint。
- AI 工作流：先 navigate 定位 → 再精确读代码/记忆，避免全量扫描。

### Phase 4：联动与治理（0.5 天）
- 业务记忆 propose 时自动建议挂载节点（AI 匹配 domain/entity）。
- 画像版本与 scope 分布健康度关联；画像缺失时 sense 提示「该项目无业务画像」。
- 技术/业务元数据 `knowledge_type` 落库，画像构建与检索过滤直接使用。

## 4. 验收标准

1. `POST /v1/project/navigate` 对 ihm-backend 返回 DOB 域树（个案→指派→审阅→审批）与依赖。
2. AI 仅凭画像 + 挂载记忆即可回答「该项目某个业务域是干什么的、依赖谁」，无需扫描代码。
3. 画像版本化：需求变动更新后 version 递增，旧版本可回溯。
4. 技术记忆仍可被其他项目检索到（通用），业务记忆仅本项目可见。

## 5. 风险与取舍

| 风险 | 对策 |
|---|---|
| 画像失真/过时（AI 幻觉、需求漂移） | AI 初稿 + 人工确认 + 版本化 + 增量更新 |
| 构建成本高 | Phase 2 半自动；先做用户核心项目（ihm-backend/Cerebrate） |
| 树/图建模过度设计 | 先 JSON 树 + relations 数组（图），够用即可，不引入图数据库 |
| 与现有 project-context 重复 | project-context 保留为「最近记忆快照」；画像为其结构化升级 |

## 6. 与用户认知模型的映射（备忘）

- 技术层面（通用）= `scope=general`，是「下次解决问题、其他项目解决问题的参考项」。
- 业务层面（项目专属）= `scope=project + project_id`，是「业务画像（数据世界）」的输入。
- 数据世界 = 画像的领域树 + 实体关系 + 依赖（树导航 + 图依赖）。
- 画像用途 = 项目信息导航，避免 AI 大面积扫描代码消耗 token。

---

## 7. v2 演进：流程视图（流程世界）— LLM 参与宏观建设（2026-08-04）

### 7.1 新增认知（用户判断，采纳）
单一数据结构（名词）不够，AI 还需「流程视图」（动词）——系统如何运行：时序、状态流转、功能交互（产品经理的时序图/流程图/UI flow/架构脑图）。**LLM 必须参与宏观数据建设**：从业务记忆提炼流程模型，人工确认。

### 7.2 双视图
- **静态结构视图**：域 → 实体 → 字段 → 关系（v1 已完成）
- **动态流程视图（v2）**：flows[] —— trigger / actors / steps(seq,actor,action,input,output,condition,detail) / state_machine(states,transitions) / depends_on / memories

### 7.3 分层披露（地图式，宏观可调控、微观不影响宏观）
| 层级 | 内容 | 用途 |
|---|---|---|
| summary（宏观） | 域列表+依赖+实体数+**流程名列表** | 一眼看全貌 |
| graph（中观） | 域+实体+关系+**流程步骤时序** | 看结构+走向 |
| detail（微观） | 完整画像（字段/记忆/状态机） | 深挖细节 |

### 7.4 实现
- ProfileStore._llm_refine prompt 扩展：要求输出 flows（时序/状态机），LLM 参与流程建模
- _sanitize：清洗 LLM 输出（None/非法类型），防渲染崩溃
- Markdown 渲染 🔄 流程世界（时序 + 状态机）
- 试点：cerebrate（5 流程：语义检索/Git 同步/MCP 蒸馏/扩展激活/崩溃修复）、ihm-backend（DOB 重指派 V2 槽位模式 6 步时序）均 confirmed
- 测试：test_flow_view 等 8 项画像测试，全量 190 passed

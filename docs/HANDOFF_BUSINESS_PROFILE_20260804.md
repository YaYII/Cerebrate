# 业务画像（数据世界+流程世界）交接文档（2026-08-04）

## 1. 任务背景与需求

用户提出核心认知模型：
1. **技术/业务二分**：项目记忆 = 技术层面（通用，可跨项目复用）+ 业务层面（项目专属）
2. **业务画像（数据世界）**：为项目建「领域树 + 实体关系 + 依赖」的导航图谱，让 AI 宏观俯瞰全貌、微观深挖细节，避免大面积扫代码/被文档淹没
3. **流程视图（流程世界）**：单有数据结构不够，AI 还需「系统如何运行」——时序/状态流转/功能交互（产品经理的时序图/流程图/UI flow/架构脑图）；**LLM 必须参与宏观数据建设**
4. **对外开放**：图谱和信息作为 MCP 工具开放，调用方 AI 自主理解（不代答），不受脑虫模型束缚

## 2. 已完成内容

### v1（commit 25dd86e）— 静态结构视图
- `cerebrate/tools/project_profile.py`：ProfileStore（数据模型/CRUD/构建草稿/导航/渲染）
- 数据模型：`{memory_root}/profiles/{project_id}.json` + Markdown 渲染
- API：`POST /v1/project/profile`（read/list/draft/save/attach）+ `POST /v1/project/navigate`
- MCP：`cerebrate_project_profile` / `cerebrate_project_navigate`（已公布，tools/list 25 工具）
- `knowledge_type=tech|business` 元数据：写入 + 存量 730 条回填
- 分层披露：summary(宏观)/graph(中观)/detail(微观)

### v2（本次）— 动态流程视图
- flows[] 数据模型：trigger/actors/steps(seq,actor,action,input,output,condition,detail)/state_machine/depends_on/memories
- `_llm_refine` prompt 扩展：LLM 从业务记忆提炼流程（时序+状态机）
- `_sanitize`：清洗 LLM 输出 None/非法类型
- Markdown 渲染 🔄 流程世界
- 分层：summary 含流程名、graph 含流程步骤

### 试点（真实数据，confirmed）
- **cerebrate**：13 域 + 5 流程（语义记忆检索/Git 同步/MCP 蒸馏/Chrome 扩展激活/崩溃修复）
- **ihm-backend**：9 域 + 1 核心流程（DOB 角色重新指派 V2 槽位模式，6 步时序含代码入口）

### 测试
- `tests/test_project_profile.py`：8 项（构建隔离/save/导航/挂载/knowledge_type/分层/流程视图/API）
- 全量：**190 passed / 0 failed**

## 3. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 查询路径零 LLM，构建期 LLM 提炼 | 调用方 AI 自主理解，能力不被脑虫模型束缚；LLM 只负责「建图」 |
| 分层披露 summary→graph→detail | 地图式：宏观可调控、微观调整不影响宏观，省 token |
| 直接 sqlite 更新元数据 | 规避 ChromaStore delete_collection 清库风险 |
| 试点 cerebrate + ihm-backend | 用脑虫项目自身验证功能完整性（用户指定） |

## 4. 遗留问题

1. **画像质量依赖 LLM 初稿 + 人工确认**：试点画像为 AI 初稿，用户可编辑 JSON 再 save 精化
2. **cerebrate 项目含少量 Chrome 扩展记忆**（历史归类），画像中「Chrome 扩展」域可在人工确认时移除
3. **自动经验记录持续增长**（usage 调度器生成），占通用分类，建议后续治理
4. **MCP 客户端需重连**才能看到新工具（服务端已公布，Claude Code/Qoder 配置已指向同一 mcp.py）

## 5. 下一步建议

1. 用户 review 两个试点画像（cerebrate/ihm-backend JSON），人工确认/精化
2. 若需要 mermaid 渲染（AI 客户端可视化时序图），可在 Markdown 渲染层加 mermaid 语法
3. 探索「流程视图」与 BPMN/状态机的自动比对（ihm-backend 有 Flowable BPMN）
4. 治理自动经验噪音（可加去重/阈值）

## 6. 关键文件与命令

- 核心：`cerebrate/tools/project_profile.py`
- 测试：`tests/test_project_profile.py`
- 设计：`docs/DESIGN_BUSINESS_PROFILE_DATAWORLD_20260804.md`
- 数据：`~/cerebrate-data/profiles/{ihm-backend,cerebrate}.json`

```bash
TOKEN=$(grep CEREBRATE_SERVER_TOKEN ~/Documents/project/Cerebrate/.env | cut -d= -f2)
# 宏观俯瞰
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"cerebrate","action":"read","level":"summary"}' http://127.0.0.1:8765/v1/project/profile
# 微观导航
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"cerebrate","target":"语义检索"}' http://127.0.0.1:8765/v1/project/navigate
# 重建草稿（LLM 精炼）
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"ihm-backend","action":"draft","llm_refine":true}' http://127.0.0.1:8765/v1/project/profile
```

---

## 7. v3 演进：代码养料收割（企业级精度核心）（2026-08-04）

### 7.1 需求
把项目真实代码/文档/数据作为「养料」喂养脑虫，画像从「记忆推断」升级为「真实代码驱动」，满足企业级精度。

### 7.2 三层养料管线
1. **文档养料**：docs/*.md + README → `/v1/ingest` 吸入知识库（Cerebrate 实测 9 文件→17 知识块）
2. **代码结构养料（新增）**：`cerebrate/tools/code_harvest.py` 用 **AST 解析**真实代码 → 模块树/数据模型（真实字段）/API 端点/类清单，存 `{memory_root}/harvest/{project_id}.json`
3. **记忆养料**：现有业务记忆

### 7.3 画像融合优先级（企业级精度）
`真实代码结构(harvest) > LLM 语义(flows/关系) > 业务记忆(经验)`：
- build_draft 支持 `use_harvest=true`：harvest 生成 domains/entities 骨架（真实 code_hint）
- LLM 在其上提炼语义域/流程，harvest 域不被覆盖则保留

### 7.4 API/MCP/CLI
- `POST /v1/project/harvest`（dir 扫描/读取）+ `cerebrate_project_harvest` MCP + `project-harvest` CLI
- profile draft 支持 `use_harvest` 参数

### 7.5 试点（cerebrate 真实代码）
- harvest：40 文件/40 模块/1 数据模型(CerebrateConfig 真实字段)/31 端点(/v1/sense 等)
- 画像 v3（代码驱动+LLM）：cerebrate 域 27 真实类（code_hint=cerebrate/brain/decision.py 等）+ 5 流程
- **精度验证**：navigate「DecisionRouter」→ 命中真实代码路径 `cerebrate/brain/decision.py`

### 7.6 Bug 修复
- `cerebrate/tools/ingest.py` line 402 `args` 未定义（既有 bug）→ 修复为 `scope=""`

### 7.7 测试
- test_harvest_code_fusion 新增；全量 **191 passed / 0 failed**

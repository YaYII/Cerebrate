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

---

## 8. v4 演进：代码同步闭环（本地代码 → 服务器代码仓）（2026-08-04）

### 8.1 需求
脑虫运行在服务器（Docker 容器），用户代码在本地，harvest 无法直接读取完整项目代码。需要「把用户完整项目代码同步过去」。

### 8.2 闭环
`本地 CLI 打包上传 → 服务器解压到 {memory_root}/code_repos/{project_id}/ → 自动 harvest（AST）→ 画像数据就绪`

### 8.3 实现
- `cerebrate/tools/code_sync.py`：
  - `build_package`：本地扫描 + tar.gz 打包（自动排除敏感文件：.env/密钥/证书/凭据/私有笔记/数据目录/二进制，实测排除 1241 项）
  - `receive_package`：服务端安全解压（拒绝绝对路径/../符号链接逃逸 + 敏感文件兜底）→ 自动 harvest
- API：`POST /v1/code/sync`；CLI：`cerebrate.py code-sync --project X --dir /path`
- 存储：`{memory_root}/code_repos/{project_id}/`（容器 /data/code_repos/，持久）
- 配置：`CEREBRATE_CODE_SYNC_MAX_BYTES`（默认 200MB）

### 8.4 关键 bug 修复
- `code_harvest.py`：SKIP_DIRS 误用绝对路径 parts，容器代码仓在 `/data/` 下被「data」规则跳过 → 改为相对路径判断

### 8.5 试点（cerebrate 真实闭环，已验证）
- CLI 上传：105 文件 / 5070KB / 排除 1241 项（.env、.git、.claude、.codegraph）
- 服务器：解压 105 文件到 /data/code_repos/cerebrate → harvest 41 文件/41 模块/1 数据模型/32 端点
- navigate「DecisionRouter」→ cerebrate/brain/decision.py（代码仓驱动）
- 测试：test_code_sync_roundtrip；全量 **192 passed / 0 failed**

---

## 9. v5 演进：基础建设加固 — 自动画像联动 + 增量同步 + 一致性校验（2026-08-04）

### 9.1 需求
用户明确：基础建设功能必须做扎实（「功能没有做好，基本死就会出现问题」），并强调「禁止背诵答案、实事求是」——记忆只是参考（参考答案），具体问题必须基于当前项目真实代码分析。

### 9.2 功能 2：自动画像联动
- code_sync 支持 `auto_profile=true`（默认）：同步后自动 build_draft + **保存为草稿**（`{project_id}.draft.json`，不覆盖人工确认版）
- ProfileStore 草稿态：`save_draft/read_draft/promote`；promote 把草稿提升为 confirmed（version+1，删除草稿文件）
- API：profile action=read_draft/save_draft/promote
- 优化：0 变更时跳过自动画像（省 LLM）

### 9.3 功能 3：增量同步
- `build_package(incremental=True)`：本地 manifest（`~/.cerebrate-sync/{project_id}.json`，sha256 全量哈希）
- 增量只打包「变更+新增」，删除文件进 `delete_list`；服务器 `_safe_remove` 安全删除
- 实测：二次 sync 变更 0 → 服务器接收仅 **45 字节**
- CLI：`--full` 强制全量、`--no-profile` 关自动画像

### 9.4 功能 4：一致性校验
- `ProfileStore.verify(project_id)`：画像 vs 代码仓（harvest）
  - code_hint 漂移检查（只对「形如代码路径」的 hint 严格校验，含中文/空格的语义描述不误报）
  - 代码仓真实类/数据模型缺漏（missing_in_profile）
  - 端点漂移检查
- API：profile action=verify；navigate 返回 `profile_verified` + `sources`（标注「业务记忆仅为参考，以代码仓真实代码为准」）
- 实测：cerebrate verify **ok=True / 0 issues / 0 missing**

### 9.5 设计理念（回应用户「禁止背诵」）
- 画像 = 项目地图（参考）；代码仓 = 事实源（权威）；记忆 = 参考答案（参考）
- navigate/画像明确标注信息源与验证状态，AI 先看真实代码再分析，不把记忆当答案背诵
- Markdown 渲染加「⚠️ 业务记忆为参考，以代码仓为准」

### 9.6 测试
- 新增：test_code_sync_incremental / test_profile_draft_and_promote / test_verify_consistency
- 全量 **195 passed / 0 failed**

---

## 10. v6 演进：四项能力全实现 + 系统边界测试（2026-08-04）

### 10.1 用户要求
「全部实现，只要结果」：① AI 客户端注入三段式工作流 ② 画像 draft promote ③ 多语言 harvest ④ verify 定期化；并验证系统边界不崩溃。

### 10.2 已实现
1. **AI 客户端注入三段式工作流**：Claude Code SessionStart hook（~/.claude/hooks/cerebrate-session-start.py）+ Qoder UserPromptSubmit hook 注入「记忆状态 + 业务画像概览 + 工作流契约（code-sync→俯瞰→微观→记忆仅参考）」
2. **画像 draft promote**：cerebrate 画像 v4（7 域 5 流程，LLM 精炼+代码仓驱动）promote 为 confirmed；新增 fix_hints（清洗 LLM 幻觉 code_hint，实测 18 条 → verify ok）
3. **多语言 harvest**：code_harvest 支持 PHP（namespace/class/function + Laravel Route::）与 Java/Kotlin（class/method + Spring 注解端点）；实测检出 /api/dob/my-processes 等
4. **verify 定期化**：scheduler 新增 verify_loop（默认 6h），遍历画像项目校验，漂移记录日志 + events 告警；实测已运行（ihm-backend no_harvest 被标记）

### 10.3 系统边界测试（tests/test_system_boundaries.py，11 项）
- 空 harvest/空目录/无画像 navigate/verify → 返回原因不崩
- 非法 level / 缺 project_id / 未知 action → ValueError（HTTP 400）
- 恶意 tar 路径穿越 → 拒绝不写出；空包 → ValueError
- 损坏 manifest → 回退全量；LLM 非法 JSON → _parse_json None → 回退骨架

### 10.4 测试
- 全量 **206 passed / 0 failed**（+11 边界测试）

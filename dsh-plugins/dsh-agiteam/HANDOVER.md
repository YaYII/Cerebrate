# dsh-agiteam 交接文档

> 2026-09-01 ｜ 给下一个接手这个插件的 AI/工程师

## v3 更新（2026-09-02）—— 崩溃修复 + 任务板审批 + 知识库自动生成

### 崩溃根因与修复（最重要的变更）
**根因**：旧实现用固定 sessionId（`session-<projectId>-<role>`），harness 会话存储对
同 id 二次创建直接抛错（"already exists"），且持久化后端拒绝重建同名日志。
进程重启后 `agents.create()` 复用旧 id → 崩溃；同项目新需求复用
`session-<project>-requirement` → 新需求内容追加进旧对话（"两个对话内容"）。

**修复**：`src/business/sessions.ts`（新）——taskboard 风格会话管理：
- 每次唤醒 = 随机唯一 id（`agiteam-<uuid>`），绝不复用旧 id；
- 已持久化会话用 `agents.resume()` 续接（不 create，天然避开崩溃）；
- 会话身份（projectId/role/reqId）编码进 meta，可恢复归属；
- 会话 id 记录到任务（tasks.sessionId），重启后可 resume 续接同一对话。

### 任务板审批（抄袭 DSH-taskboard 设计）
- 状态机：`open → claimed → in_progress → in_review → done`，分支 `rejected`（打回）/ `paused`（暂停）；
- **只有 owner（你）能 approve**：`agiteam_approve` 放行推进，`agiteam_reject` 打回，
  `agiteam_pause` 随时暂停，`agiteam_resume` 恢复；
- AI 代审批：`agiteam_ai_approve` 提交建议（含依据），你采纳/驳回；
- 乐观锁 version（updatedAt）防并发覆盖；
- `agiteam_task_list` 查看任务板。

### Obsidian 知识库自动生成
- 阶段产物自动落盘（已有，v2）；
- 新增《任务板审批记录.md》：审批放行/打回/暂停/恢复/AI 建议 全量记录（`syncApprovalsToKb`）。

### 新增文件
```
src/business/sessions.ts    ← 会话管理（随机 id + resume 续接）
src/business/taskboard.ts   ← 任务板状态机 + 审批门禁（approve/reject/pause/resume/claim）
```

### 变更文件
```
src/business/domain.ts      ← TaskRecord 扩展（sessionId/审批字段/暂停字段）
src/business/auto-drive.ts  ← autoAdvance 改提交 in_review；新增 approveStage/rejectStage/pauseStage/resumeStage/aiApproveSuggestion/wakeStageRole
src/business/tools.ts       ← 新增 6 个审批工具 execute
src/business/web.ts         ← 新增 /plugins/agiteam/tasks 路由 + buildBoardSnapshot
src/client/AgiteamPanel.tsx ← 任务板视图（列/卡片/审批状态）
src/client/agiteam.css      ← 任务板样式
src/index.ts                ← 注册 6 个新工具
```

### v3 门禁状态
- ✅ 注释语言 / 类型（host+client）/ 55 测试 / 构建（host+client）全部通过
- ⚠️ 需运行时验证：重启 dsh web 后创建项目，确认角色会话用随机 id、审批流程可用

### v3 待办（接手清单）
1. **运行时验证**：重启 dsh web → agiteam_start → 角色完成 → agiteam_done（应进 in_review）→ agiteam_approve（应推进）。
2. **preset 引导更新**：角色 preset persona 需加入"完成后调用 agiteam_done（提交审批）"指令（已在 v2 加过 agiteam_done，确认含审批提示）。
3. **迁移旧数据**：旧项目的固定 sessionId 任务记录（sessionId 为空）→ 下次唤醒自动创建新随机会话（已兼容）。

---

## v2 更新（2026-09-01 下午）

新增**可视化面板 + 追溯链 + 审计日志 + 多层校验**：

### 新增文件
```
src/features/trace.ts     ← 追溯矩阵（需求→功能→用例→单测→代码→验收脚本）
src/features/audit.ts     ← 审计日志（追加式 JSONL + sha256 链式哈希）
src/features/verify.ts    ← 多层校验（数学/脚本/日志 三层）
src/business/web.ts       ← webServer 路由（GET /plugins/agiteam/state + POST /audit + /verify）
src/client/               ← Client 半体（React 面板：项目/追溯矩阵/审计/校验）
tsconfig.client.json      ← client 编译配置（react-jsx + DOM lib）
tsdown.client.config.ts   ← client 打包（ModuleLoader bundle 格式）
```

### 关键机制（v2）
1. **追溯链数据流**：角色 agent 通过 `POST /plugins/agiteam/audit` 上报实体（`register-requirement`/`register-feature`/`register-testcase`/`register-unittest`/`register-codefile`/`register-script`），detail 为 JSON 实体 → 落盘 `audit.jsonl` → `buildTraceSnapshot` 从审计还原实体 → 追溯矩阵 + 三层校验。
2. **审计防篡改**：每条目 hash = sha256(seq|time|action|role|detail|fingerprint|prevHash)，链式连续；篡改任何一条 → `verifyAuditChain` 返回断裂位置。
3. **Client 半体加载**：package.json `dsh.client` 声明（platform:web + inject）→ host clientModules 从 loader entry 向上找 package.json 发现 → 服务 `lib/client.js` 到 `/plugins` → 浏览器 ModuleLoader 加载。
4. **Client 打包**：`build:client` = tsc（tsconfig.client.json 产 lib/types/client）+ tsdown（tsdown.client.config.ts 产 lib/client.js，`window.__ModuleLoader__.load` 格式，react 走 externals）。

### v2 待办（接手清单）
1. **角色 agent 上报接入**：✅ 已完成（2026-09-01 晚间）——9 个角色 preset persona 已加入登记指令（requirement→register-requirement、product→register-feature、test-designer→register-testcase、developer→register-codefile/register-unittest、tester→agiteam_run_acceptance + register-script）。新增工具 `agiteam_register`（登记实体）+ `agiteam_run_acceptance`（执行验收脚本+日志+审计）。
2. **产物解析增强**：`buildTraceSnapshot` 目前从审计动作还原实体；若产物 md（requirements.md 等）格式稳定，可增强为解析 md 提取结构化实体（更完整）。
3. **验收脚本执行**：已通过 `agiteam_run_acceptance` 工具实现（tester 调用，真实命令+日志+审计）。若需插件自动批量执行 + 汇总，在 engine 接入 runner.ts。
4. **端到端验证**：`scripts/e2e-verify.mjs` 已验证全闭环（角色登记→追溯矩阵→三层校验全通过），可复用。

## 任务背景

用户发现现有 `dsh-pipeline-kernel` 的缺陷：
1. 任务投递到对话只有标题、没有内容（description 被塞进任务单文件）；
2. 它是"管线无关的管理内核"，没有业务阶段（需求分析/评审/测试验收），团队开发流程空转。

用户要的是：**接需求 → 按传统软件团队流程，多角色 AI 子 agent 协作，完成需求分析→评审→产品→用例→开发→逐功能验收→端到端验收的完整流程**。

## 交付物

```
dsh-plugins/dsh-agiteam/
├── src/
│   ├── index.ts              ← 装配层：agiteam_* 工具注册 + 引导注入
│   ├── features/             ← 功能砖块（stage 状态机 / model / render / runner）
│   └── business/             ← 业务编排（engine / roles / tools）
├── presets/                  ← 9 个角色 preset（agent.cordis.yml + preset.yml）
├── tests/                    ← 16 个单元测试（stage + engine）
├── scripts/                  ← check-all.mjs（门禁）/ check-comments.mjs / gen-presets.mjs
├── lib/index.js              ← 构建产物（tsdown）
├── cordis.patch.yml          ← 插件注册配置（供追加到 profile）
├── README.md                 ← 使用文档
└── AGENTS.md                 ← 项目宪法（注释中文/分层/门禁）
```

已安装位置：
- 插件注册：`~/.dsh/profiles/web/cordis.patch.yml`（追加了 agiteam insert 块）
- 9 个角色 preset：`~/.dsh/.agent-presets/agiteam-*/`

## 验证状态

- ✅ 单元测试 16/16 通过（`node scripts/check-all.mjs` 全绿）
- ✅ 类型检查通过（tsc --noEmit）
- ✅ 构建成功（lib/index.js 可加载，导出 name=dsh-agiteam, inject=['tools']）
- ✅ 9 个 preset 完整（257 行，persona 已替换为角色职责，元数据齐全）
- ⏳ **尚未运行时验证**：插件需要重启 dsh web 服务才加载（当前进程是存量会话，工具目录固定）

## 关键设计决策（接手前必读）

1. **与 pipeline-kernel 共存**：dsh-agiteam 是独立插件，不碰 pipeline-kernel 的注册表/任务板。它用自己的 `.teamdev/<项目>/state.json` 管理项目状态，用自己的 `agiteam_*` 工具。两套系统可以并行。

2. **agent 创建配方**（来自 pipeline-kernel 的 seed.js + harness 官方配方）：
   ```ts
   agents.create({
     sessionId,                    // 稳定 id：session-<projectId>-<role>
     meta: { cwd, agentPreset: presetId },
     setup: async (agentCtx) => { await agentPresets.mount(agentCtx, presetId) }
   })
   ```
   创建后 `agent.followup(createUserMessage(...))` 投递首条引导消息（让会话非 blank 且带内容）。

3. **评审门禁**：三个评审阶段（req-review/product-review/testcase-review）由评审角色判定 pass/打回；`advanceStage(state, passed)` 在 `passed=false` 且当前是评审阶段时自动回退到上一阶段（`reviewBackTo` 映射），并带评审意见重做。

4. **内容回灌对话**（修 pipeline-kernel 缺陷）：每个阶段产物（requirements.md 等）渲染为 Markdown，通过 `stageGreeting` 作为引导消息内容投递给负责角色——对话里有完整内容，不只是标题。

5. **产物落盘**：`<cwd>/.teamdev/<projectId>/` 下，state.json + 各阶段 md。`agiteam_artifact` 可读取。

## 需要重启后做的事（接手清单）

1. 重启 dsh web 服务（守护脚本会自动拉起，或 `pnpm dsh web`）。
2. 新建会话验证 `agiteam_*` 工具可见。
3. 跑一次端到端冒烟：
   ```
   agiteam_start { projectName: "测试项目", requirement: "..." }
   agiteam_status { projectId: "..." }
   agiteam_advance { projectId: "...", passed: true }
   ```
4. 验证角色 agent 会话被创建（session-<projectId>-<role>）且收到引导消息。
5. 若评审打回路径有问题（agent 未唤醒），检查 engine.ts 的 `wakeRoleAgent`（live 会话用 followup，非 live 重建）。

## 已知限制 / 待改进

1. **`agentOptions` 未指定模型**：创建 agent 走 preset 默认模型路线。若需按角色区分模型（如评审用更强模型），在 `createRoleAgent` 加 `agentOptions: { provider, model }`。
2. **架构师角色未接入状态机**：9 个角色里 architect 的 preset 已就绪，但状态机目前是 9 阶段（无独立架构阶段）。若需"架构评审"门，在 stage.ts 加阶段 + engine.ts 加角色映射。
3. **无 Web UI**：只有工具，没有控制面板。若要可视化（像 pipeline-kernel 的侧栏），需写 client 半体。
4. **验收测试执行**：runner.ts 已有子进程执行能力，但 `feature-accept` 阶段目前由 tester 角色 agent 自行调用系统 shell 执行测试。若需插件直接跑测试（如 `npm test`），在 engine 的 feature-accept 阶段接入 runner.ts。

## 依赖清单（node_modules 链接）

dsh-agiteam 的 node_modules 是符号链接到 deepseek-harness：
- `@deepseek-ai/*` → `vendor/` 或 `packages/*`（cordis→vendor/cordis, dsh-tools→packages/core/tools 等）
- `typescript/vitest/vite` → harness 的 pnpm store（vitest 指向完整 store 包）
- 若重装依赖，参照 dsh-code-review 的 node_modules 链接方式（它是同构参考）

## 记忆沉淀

已在 cerebrate 记忆（project_id=deepseek-harness）提交：
- 插件开发依赖链接方式（vendor/packages/pnpm store）
- dsh-agiteam 设计决策（阶段状态机/评审门禁/agent 创建配方）

---

## v4 更新（2026-09-02 晚）—— taskboard 底座融合 + 我的工作台

### 架构定案（完整复制 taskboard，UI 全盘照抄 + AGI 改造）
用户要求：UI 全盘照抄 taskboard（看板/详情/评论/附件/Markdown 输入预览），
并加「我的审批工作台」。选定路线：**把 taskboard 完整源码复制进 dsh-agiteam**。

### 关键构建决策（踩坑记录）
1. **taskboard 源码 = Apache-2.0 vendored**：放 `src/taskboard/`（host）+ `src/generated/`（typert 生成），注释检查排除（英文注释是原作者）。
2. **依赖打通**：`node_modules/@deepseek-ai/*` 符号链接指向 harness packages（
   dsh-typert-protocol/dsh-agent-presets/dsh-goal/dsh-workspace/dsh-host-webserver/dsh-client-connection 等，全部已构建 lib）。
3. **装饰器陷阱**：taskboard 的 service 用 `@Remote()`（TC39 标准装饰器），
   **tsdown/rolldown 不转换装饰器**（原样输出 → 语法错误）！解法：taskboard host 用
   **tsc 预编译**（tsc 转 `__esDecorate`）到 `lib/taskboard-host/`，tsdown 打包时
   tsdown 会把 tsc 产物搬进 chunk（装饰器已转，合法）。构建脚本：`build:tb-host`（tsc）+ `build`（tsdown）。
4. **client 融合**：dsh-agiteam 的 `src/client/index.tsx` 改为薄壳，重新导出 taskboard 的
   apply/inject（bundle 打包含 taskboard UI）。
5. **工作台视图**：TaskboardView 加 `'workbench'`；TaskboardPage 加 tab + Workbench 组件
   （待我审批 in_review / 进行中 / 待办队列 / 已完成，一键 accept 放行 / returnForRework 打回）。

### 运行配置（profile）
- profile bundles 移除 `@shengsheng/dsh-taskboard`（dsh-agiteam 全权接管，避免双注册冲突）；
- dsh-agiteam 的 cordis.patch.yml 自动应用（数据库路径用代码内默认 `~/.dsh/profiles/web/.dsh/taskboard.sqlite`）。

### 需要重启验证
- 重启 dsh web → 侧边栏出现 taskboard 按钮（dsh-agiteam 提供）→ 打开页面 → 顶部「工作台」tab
  → 用 agiteam_start 建项目 → 任务出现在看板 → AI 完成进 in_review → 工作台放行 → 下一阶段。

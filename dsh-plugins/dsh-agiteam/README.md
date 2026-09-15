# dsh-agiteam — AGI 团队开发引擎

> DeepSeek Harness (DSH) 插件 ｜ 接需求 → 按传统软件团队流程多角色 AI 协作完成开发与验收

## 解决的问题

现有 `dsh-pipeline-kernel` 只做**管线无关的任务板**（任务标题+状态流转），有两个缺陷：

1. **对话里只有标题没内容** —— 任务描述被塞进任务单文件，不进对话；
2. **没有业务阶段** —— 没有需求分析/评审门禁/测试验收，团队流程"空转"。

`dsh-agiteam` 补上完整业务层：**需求分析 → 需求评审 → 产品设计 → 产品评审 → 测试用例设计 → 用例评审 → 正式开发 → 逐功能验收 → 端到端验收 → 交付**，每个阶段由不同角色子 agent 执行。

## 安装

```bash
# 1. 构建
cd dsh-plugins/dsh-agiteam && pnpm build

# 2. 注册插件（追加到 ~/.dsh/profiles/web/cordis.patch.yml）
#    - insert:
#        - id: agiteam
#          name: '/path/to/dsh-agiteam/lib/index.js'
#          config: { artifactsDir: '.teamdev', injectGuidance: true }

# 3. 安装 9 个角色 preset 到用户根
cp -r presets/* ~/.dsh/.agent-presets/

# 4. 重启 dsh web 服务（新会话才带 agiteam_* 工具）
```

## 使用

| 工具 | 作用 |
| --- | --- |
| `agiteam_start` | 启动项目：输入项目名+原始需求，自动进入需求分析 |
| `agiteam_status` | 查项目当前阶段/已完成阶段/评审意见/产物 |
| `agiteam_advance` | 推进阶段：`passed=true` 放行，评审阶段 `passed=false` 打回返工 |
| `agiteam_task` | 分派具体任务给指定角色 agent |
| `agiteam_artifact` | 读取阶段产物（需求清单/功能清单/用例矩阵/验收报告） |
| `agiteam_register` | **登记追溯实体**：角色完成需求/功能/用例/单测/代码/脚本后登记，写入审计日志（带指纹），成为追溯矩阵与多层校验数据源 |
| `agiteam_run_acceptance` | **执行验收脚本**：运行真实命令 + 记录运行日志 + 登记审计（脚本层/日志层证据） |
| `agiteam_done` | **阶段完成自动推进**：角色完成任务后调用，自动推进到下一阶段并唤醒下一角色（全自动驱动） |
| `agiteam_review` | **评审判定**：评审角色判定 通过/打回，自动流转（通过前进，打回带意见返工） |

## 可视化面板（v2）

右下角 **AGI 团队** 胶囊按钮 → 右侧全高侧栏：

- **项目**：各项目阶段/进度/校验状态
- **追溯矩阵**：需求 → 功能 → 用例 → 单测 → 代码 → 验收脚本 一行式追溯
  （每个功能对应哪个需求、哪个用例、哪个单测、哪段代码、哪个验收脚本）
- **审计日志**：追加式 JSONL + sha256 链式哈希（每条含 时间/角色/动作/指纹），防篡改可追溯
- **校验**：多层校验（数学层对账 + 脚本层存在性 + 日志层链完整）

数据来自 host `/plugins/agiteam/state` 快照（1s 轮询），动作转发 host。

## 追溯链（防 AI 幻觉，多层校验）

```
需求 R-x ──→ 功能 F-y ──→ 用例 TC-z ──→ 单测 UT-w
   │            │              │
   │            ├──→ 代码文件 CF (src/xxx.ts)
   │            └──→ 验收脚本 AS (scripts/xxx.sh) ──→ 真实运行日志
```

三层校验（`/plugins/agiteam/verify`）：
1. **数学层**：需求↔功能↔用例↔单测↔代码↔脚本 数量对账（每个功能都有用例/单测/代码/脚本）
2. **脚本层**：验收脚本文件真实存在 + 有运行记录（非 AI 声称）
3. **日志层**：审计日志链完整（sha256 链式校验无断裂）+ 验收脚本有真实日志文件

## 审计日志（POST /plugins/agiteam/audit）

角色 agent 每步动作上报：`{ projectId, role, stage, action, detail, fingerprint }`
→ 追加到 `<项目>/.teamdev/<项目id>/audit.jsonl`，链式哈希防篡改。

## 自动驱动（v3）

**全自动接力**：`agiteam_start` 启动项目 → 自动唤醒需求分析师 → 每阶段角色完成后调用 `agiteam_done` → 自动推进到下一阶段并唤醒下一角色 → 评审阶段 `agiteam_review` 判定 → 直到 `done` 交付。无需手动 advance。

```
角色完成 → agiteam_done → 自动推进+唤醒下一角色 → ... → done
评审角色 → agiteam_review(通过/打回) → 自动前进或打回返工
```

## 数据库持久化（v3）

基于官方 storageDomain（JSON 后端，落盘 `~/.dsh/storages/agiteam.json`）：

| 表 | 内容 |
| --- | --- |
| `projects` | 项目状态（阶段/评审意见/产物/autoDrive） |
| `entities` | 追溯实体（需求/功能/用例/单测/代码/脚本） |
| `audit` | 审计日志（链式哈希防篡改） |
| `tasks` | 阶段任务（执行角色/状态/结果） |

数据可靠落盘、可查询、可追溯，替代早期文件系统方案。

## 团队流程（9 阶段）

```
requirement(需求分析,需求分析师)
  → req-review(需求评审,需求评审员) — 不过打回 requirement
  → product(产品设计,产品经理)
  → product-review(产品评审,产品评审员) — 不过打回 product
  → testcase(用例设计,测试设计师)
  → testcase-review(用例评审,测试设计师) — 不过打回 testcase
  → develop(正式开发,开发工程师,每功能点+单元测试)
  → feature-accept(逐功能验收,测试验收员,单测+API+脚本)
  → e2e-accept(端到端验收,测试验收员,模拟用户场景)
  → done(交付)
```

## 角色（9 个 preset）

`agiteam-supervisor`(主管) / `agiteam-requirement`(需求) / `agiteam-architect`(架构) / `agiteam-product`(产品) / `agiteam-req-reviewer`(需求评审) / `agiteam-prod-reviewer`(产品评审) / `agiteam-test-designer`(测试设计) / `agiteam-developer`(开发) / `agiteam-tester`(验收)

每个角色 = 独立会话 + 独立 preset persona（由 standard 派生，保证组合可加载）。

## 产物目录

`<项目>/.teamdev/<项目id>/`：

| 文件 | 内容 |
| --- | --- |
| `state.json` | 项目状态（阶段/评审意见/产物映射） |
| `requirements.md` | 需求清单 |
| `features.md` | 产品功能清单 |
| `testcases.md` | 测试用例矩阵（功能↔用例） |
| `acceptance.md` | 逐功能验收报告 |
| `e2e.md` | 端到端场景验收 |

## 架构

```
src/
├── index.ts              ← 装配层：agiteam_* 工具注册 + 阶段引导注入 + web 路由注册
├── features/             ← 功能砖块（纯能力）
│   ├── stage.ts          ← 9 阶段状态机 + 评审打回
│   ├── model.ts          ← 需求/功能/用例/验收/追溯/审计 数据形状
│   ├── render.ts         ← 文档 Markdown 渲染
│   ├── runner.ts         ← 验收测试子进程执行
│   ├── trace.ts          ← 追溯矩阵（需求→功能→用例→单测→代码→脚本）
│   ├── audit.ts          ← 审计日志（追加式 JSONL + sha256 链式哈希）
│   └── verify.ts         ← 多层校验（数学/脚本/日志 三层）
├── business/             ← 业务编排（组合功能砖块）
│   ├── engine.ts         ← 阶段编排 + agent 创建/唤醒 + 产物落盘
│   ├── roles.ts          ← 9 角色定义 + preset 映射
│   ├── tools.ts          ← agiteam_* 工具顶层 execute
│   └── web.ts            ← webServer 路由（GET /state + POST /audit + /verify）
└── client/               ← Client 半体（React 面板，ModuleLoader bundle）
    ├── index.tsx         ← 入口（body portal 挂载）
    ├── AgiteamPanel.tsx  ← 面板（项目/追溯矩阵/审计/校验）
    └── agiteam.css       ← 面板样式（DSH 主题变量）
```

分层铁律：装配层 → 业务层 → 功能层（依赖单向）；环境敏感逻辑集中在 runner.ts。
Client 半体经 package.json `dsh.client` 声明被 host clientModules 自动发现并服务到 `/plugins`。

## 开发门禁

```bash
node scripts/check-all.mjs   # 注释语言 + 类型 + 测试 + 构建 一键全过
```

## License

MIT

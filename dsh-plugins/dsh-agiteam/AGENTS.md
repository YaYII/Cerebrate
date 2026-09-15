# dsh-agiteam 开发守则（AI 必读）

> 本文件是项目宪法。任何 AI（人或模型）在本目录写代码前必须阅读并遵守；
> 写完代码后必须跑完门禁才能宣称完成。

## 铁律（违反即返工）

1. **注释一律简体中文**：文件头、函数说明、行内注释全部中文；英文注释 = P0 缺陷。
   专有名词（DSH/Cordis/agent/subagent/preset/API 等）可保留英文；中文注释允许
   夹带英文技术词（spawn/ENOENT/dirty-file 等），但注释主体必须是中文。
2. **解释「为什么」**：注释说明意图与约束，不重复代码本身。
3. **禁止**：死代码、注释掉的代码、TODO/FIXME 遗留、`any`、`@ts-ignore`、默认导出。
4. **分层铁律**：功能是砖块、业务是组合。
   - `src/features/`（纯能力，禁止 import business 层、禁止业务专属词汇）：
     stage（阶段状态机）、model（需求/产品/用例/验收文档模型）、render（文档渲染）、
     runner（子进程运行测试）。
   - `src/business/`（编排组合，可自由重组）：engine（阶段编排）、
     roles（角色预设与 agent 创建配方）、tools（工具顶层 execute）。
   - `src/index.ts`（装配层）：唯一引用 business 层；只做工具注册与引导注入。
5. **契约与实现分离**：工具描述（defineTool 的 description/parameters）与行为
   （business 层 execute）分离；execute 必须是顶层导出函数（可独立单元测试）。
6. **依赖单向**：装配层 → 业务层 → 功能层；功能层之间允许互引。
7. **错误路径中文可操作**：工具失败返回 `{ status: 'error', message: '中文提示' }`。
8. **命名表意**：nextStage 不叫 next；executeStartProject 不叫 run。

## 完成门禁（每次代码修改后必须全过）

```bash
# 一键门禁：注释语言 + 类型 + 测试 + 构建
node scripts/check-all.mjs

# 或分步：
node scripts/check-comments.mjs        # 注释语言（纯英文注释即失败）
node node_modules/typescript/bin/tsc --noEmit   # 类型
node node_modules/vitest/vitest.mjs run         # 测试
node node_modules/tsdown/dist/run.mjs           # 构建
```

门禁不过 = 任务未完成。先修复，再重新跑门禁，直到全绿。

## 架构地图

```
src/
├── index.ts              ← 装配层：agiteam_* 工具注册 + 阶段引导注入
├── features/             ← 功能砖块（纯能力，禁止 import business 层）
│   ├── stage.ts          ← 9 阶段状态机（requirement → … → done）+ 评审打回
│   ├── model.ts          ← 需求清单/产品功能清单/用例矩阵/验收报告数据形状
│   ├── render.ts         ← 各阶段产物文档渲染（Markdown）
│   └── runner.ts         ← 子进程执行验收测试（单测/API/脚本/E2E）
└── business/             ← 业务编排（组合功能砖块）
    ├── engine.ts         ← 阶段编排：状态机 + agent 创建 + 产物落盘 + 唤醒
    ├── roles.ts          ← 8 角色预设（主管/需求/架构/产品/评审/测试/开发/验收）
    └── tools.ts          ← agiteam_* 工具的顶层 execute
```

**分层铁律**：features 层禁止 import business 层（依赖单向）；业务词汇只出现在
business 层；环境敏感逻辑（spawn/路径/平台差异）集中在 runner.ts 单点。

## 提交规范

`类型(模块): 中文描述`（feat/fix/refactor/docs/test/chore）；一个提交只做一件事。

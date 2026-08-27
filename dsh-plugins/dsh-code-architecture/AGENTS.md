# dsh-code-architecture 开发守则（AI 必读）

> 项目宪法 CODE_STANDARDS.md 的执行入口。写代码前必读，写完后跑完门禁才算完成。

## 铁律
1. 注释一律简体中文（英文 = P0 缺陷）。中文注释允许夹带英文技术词
   （spawn/cyclomatic/defineTool 等），但注释主体必须是中文。
2. 注释解释「为什么」。禁死代码/TODO/any/@ts-ignore/默认导出。
3. 功能是砖块、业务是组合：功能层原子可复用、不绑业务；业务层只编排。
4. 功能层禁止 import 业务层；功能层禁止业务专属词汇。
5. 契约与实现分离、依赖单向、命名表意。
6. 工具 execute 必须是顶层导出函数（business/tools.ts），独立可测；
   index.ts 只做装配（defineTool 薄壳 + 引导注入）。

## 完成门禁
```bash
node scripts/check-all.mjs   # 注释语言 + tsc + vitest + tsdown，全过才算完成
```

## 架构地图

```
src/
├── index.ts              ← 装配层：八个工具注册（arch_*/qa_*）+ 引导注入 + 程序化再导出
├── features/             ← 功能砖块（纯能力，禁止 import business 层）
│   ├── checks.ts         ← 架构自检检查器（C1 注释语言/N1 命名/D1 重复/S1 分离/E1 依赖方向）
│   ├── fingerprint.ts    ← 架构指纹与漂移（文件清单+sha256/分层边界/依赖方向）
│   ├── aop.ts            ← AOP 执行观测（探针编排/热点统计/报告文本）
│   ├── instrument.ts     ← 探针注入（aop 的地基，纯文本改写）
│   ├── metrics.ts        ← 质量指标（圈复杂度/注释率/函数数/测试存在性）
│   ├── mutation.ts       ← 变异测试（6 类变异体注入 + 测试驱动）
│   └── gherkin.ts        ← Gherkin 场景生成（Given/When/Then 骨架）
└── business/             ← 业务编排（组合功能砖块）
    └── tools.ts          ← 八个工具的顶层 execute（check/fingerprint/aop/guide/qa_*）
```

**分层铁律**：features 层禁止 import business 层（依赖单向）；业务词汇只出现在
business 层；检查器只报事实，AI 依据事实决策。

## 提交规范
`类型(模块): 中文描述`（feat/fix/refactor/docs/test/chore）；一个提交只做一件事。

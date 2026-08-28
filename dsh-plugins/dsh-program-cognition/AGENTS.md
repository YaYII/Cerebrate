# dsh-program-cognition 开发守则（AI 必读）

> 项目宪法 CODE_STANDARDS.md 的执行入口。写代码前必读，写完后跑完门禁才算完成。

## 铁律
1. 注释一律简体中文（英文 = P0 缺陷）。中文注释允许夹带英文技术词
   （callId/spanId/defineTool 等），但注释主体必须是中文。
2. 注释解释「为什么」。禁死代码/TODO/any/@ts-ignore/默认导出。
3. 功能是砖块、业务是组合：features/ 原子可复用、不绑业务；business/ 只编排。
4. features/ 禁止 import business/；features/ 禁止业务专属词汇。
5. 引擎 B 的事件监听只允许在 index.ts 注册（装配职责），features/agentTrace
   只做纯数据聚合（可独立测试）。
6. 安全红线：写源码必须 dryRun+备份；任何摘要必须脱敏。
7. 工具 execute 必须是顶层导出函数（business/tools.ts），独立可测；
   index.ts 只做装配（defineTool 薄壳 + 事件监听 + llm 注入）。

## 完成门禁
```bash
node scripts/check-all.mjs   # 注释语言 + tsc + vitest + tsdown，全过才算完成
```

## 架构地图

```
src/
├── index.ts              ← 装配层：六个工具注册（cog_*）+ 引擎 B 事件监听
│                            （agent/* + session/event）+ llm 注入 + 引导注入
├── features/             ← 功能砖块（纯能力，禁止 import business 层）
│   ├── scanner.ts        ← 静态砖块/服务/工具分类（5 规则 + 编排提升 S1）
│   ├── templates.ts      ← 埋点模板（入口/出口/状态变更三类）
│   ├── instrument.ts     ← 源码注入（dryRun 预览 + 备份回滚）
│   ├── collector.ts      ← 运行时行为采集（runner 生成 + stage 加载）
│   ├── graph.ts          ← 认知图谱聚合（节点/边/热点/gaps/焦点裁剪）
│   ├── agentTrace.ts     ← 引擎 B 事件聚合（AgentBehaviorRecord/幽灵路径/配对）
│   ├── redact.ts         ← 脱敏与摘要（全插件安全兜底）
│   └── translate.ts      ← 语义翻译（复用 ctx.llm，降级模板拼接）
└── business/             ← 业务编排（组合功能砖块）
    └── tools.ts          ← 六个工具的顶层 execute（scan/instrument/trace/graph/agent/guide）
```

**分层铁律**：features 层禁止 import business 层（依赖单向）；业务词汇只出现在
business 层；检查器只报事实，AI 依据事实决策。

## 测试与示例
- tests/*.spec.ts —— 单元测试（47 个，全绿）。
- tests/e2e.spec.ts —— examples/demo-shop 端到端（临时副本运行，示例永不被污染）。
- examples/demo-shop/ —— 演示项目（只读模板，勿直接修改）。

## 提交规范
- `类型(模块): 中文描述`，如 `feat(scanner): 支持中文函数名分类`。
- 一个提交只做一件事。

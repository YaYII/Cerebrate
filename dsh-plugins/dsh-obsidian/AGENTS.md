# dsh-obsidian 开发守则（AI 必读）

> 团队知识库插件的执行宪法。写代码前必读，写完跑完门禁才算完成。

## 铁律（违反即返工）

1. **注释一律简体中文**：文件头、函数说明、行内注释全部中文；英文注释 = P0 缺陷。
   专有名词（Obsidian/DSH/REST/API 等）可保留英文；中文注释允许夹带英文
   技术词（vault/HTTPS/fetch 等），但注释主体必须是中文。
2. **解释「为什么」**：注释说明意图与约束，不重复代码本身。
3. **禁止**：死代码、注释掉的代码、TODO/FIXME 遗留、`any`、`@ts-ignore`、默认导出。
4. **分层铁律**：功能是砖块、业务是组合。
   - `src/features/`（纯能力，禁止 import 装配层）：
     rest.ts（密钥解析 + 底层 HTTP 请求——唯一发起网络的地方）、
     obsidian.ts（vault 文件层客户端）、brain.ts（Brain 服务端客户端）、
     launcher.ts（Obsidian 自愈启动器）。
   - `src/index.ts`（装配层）：唯一引用 features；只做工具注册、引导注入、
     自愈触发。
   - 工具 execute 是薄壳：调用 features 能力 + 状态判断 + 错误归一化，
     不写业务逻辑。
5. **契约与实现分离**：Config 实现 features/rest 的 ClientConfig 形状；
   工具描述与行为分离。
6. **依赖单向**：装配层 → 功能层；功能层之间允许互引（launcher 依赖
   obsidian 的 probeObsidian）。
7. **错误路径中文可操作**：网络失败降级为结构化错误（`ok: false` +
   原因），绝不抛异常让模型看到 stack。
8. **命名表意**：obsidianCall 不叫 call；ensureObsidianRunning 不叫 start。

## 完成门禁（每次代码修改后必须全过）

```bash
# 一键门禁：注释语言 + 类型 + 测试 + 构建
node scripts/check-all.mjs

# 或分步：
node scripts/check-comments.mjs               # 注释语言（纯英文注释即失败）
node node_modules/vitest/vitest.mjs run       # 测试
node node_modules/tsdown/dist/run.mjs         # 构建
# 类型检查：node node_modules/typescript/bin/tsc --noEmit（typescript 未安装时跳过）
```

门禁不过 = 任务未完成。先修复，再重新跑门禁，直到全绿。

## 架构地图

```
src/
├── index.ts              ← 装配层：obsidian_* / knowledge_* 工具注册 + 引导注入 + 自愈触发
├── invariant.ts          ← 包自有的 invariant 伴侣（生命周期协议）
└── features/             ← 功能砖块（纯能力，禁止 import 装配层）
    ├── rest.ts           ← 密钥解析（环境变量→文件）+ 底层 HTTP 请求 + 数据形状
    ├── obsidian.ts       ← vault 文件层客户端（REST 调用/路径编码/状态探测）
    ├── brain.ts          ← Brain 服务端客户端（v5 协议信封）
    └── launcher.ts       ← Obsidian 自愈启动（进程探测/单实例锁/X11 认证）
```

**分层铁律**：features 层禁止 import 装配层（依赖单向）；网络敏感逻辑集中在
rest.ts 单点；工具描述（中文）与行为分离。

## 提交规范

`类型(模块): 中文描述`（feat/fix/refactor/docs/test/chore）；一个提交只做一件事。

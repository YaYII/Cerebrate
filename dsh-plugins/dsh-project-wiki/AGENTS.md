# dsh-project-wiki 开发守则（AI 必读）

> 本文件是项目宪法 CODE_STANDARDS.md 的执行入口。任何 AI（人或模型）在本目录
> 写代码前必须阅读并遵守；写完代码后必须跑完门禁才能宣称完成。

## 铁律（违反即返工）

1. **注释一律简体中文**：文件头、函数说明、行内注释全部中文；英文注释= P0 缺陷。
   专有名词（Mermaid/Obsidian/DSH/API 等）可保留英文。
2. **解释「为什么」**：注释说明意图与约束，不重复代码本身。
3. **禁止**：死代码、注释掉的代码、TODO/FIXME 遗留、`any`、`@ts-ignore`、默认导出。
4. **契约与实现分离**：工具描述只写 contracts.ts（单一真源），实现只写行为。
   改契约必须同步改实现签名，禁止漂移。
5. **依赖单向**：装配层（index.ts）→ 能力层（io/writer/build/evolve/scanner/mermaid）。
6. **错误路径中文可操作**：工具失败返回 `{ status: 'error', message: '中文提示' }`。
7. **命名表意**：scanProject 不叫 scan；buildTaskText 不叫 task。

## 完成门禁（每次代码修改后必须全过）

```bash
# 一键门禁：注释语言 + 类型 + 测试 + 构建
pnpm check

# 或分步：
node scripts/check-comments.mjs   # 注释语言（英文注释即失败）
node node_modules/typescript/bin/tsc --noEmit   # 类型
node node_modules/vitest/vitest.mjs run         # 测试
node node_modules/tsdown/dist/run.mjs           # 构建
```

门禁不过 = 任务未完成。先修复，再重新跑门禁，直到全绿。

## 架构地图

| 文件 | 职责 | 依赖 |
|---|---|---|
| contracts.ts | 工具契约注册表（单一真源） | 无 |
| io.ts | 目录树/读文件（纯 IO，零解析） | 无 |
| writer.ts | 页面落盘/frontmatter/git | 无 |
| mermaid.ts | Mermaid 语法检查与清洗（R1-R8） | 无 |
| scanner.ts | 文件清单+sha256（变更检测地基） | 无 |
| evolve.ts | 快照/判变/增量进化 | scanner |
| build.ts | 子代理编排（模型继承/任务驱动） | dsh-agent |
| index.ts | 装配工厂（契约×实现→工具） | 全部 |

## 提交规范

`类型(模块): 中文描述`（feat/fix/refactor/docs/test/chore）；一个提交只做一件事。

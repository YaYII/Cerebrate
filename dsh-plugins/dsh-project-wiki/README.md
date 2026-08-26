# @deepseek-ai/dsh-project-wiki

AI 主导的项目知识库插件（DSH 原生）。

核心理念：**知识库由 AI 建造，插件只提供服务**。

- 不解析代码、不生成内容：传统公式化扫描/模板渲染已删除；
- AI 用 wiki_tree 看真实目录树 → 识别模块边界（前后端分离项目的 backend/ frontend/ docker/ database/ 各是独立知识区域）；
- AI 用 wiki_read 通读关键文件（README/依赖/入口/配置）→ 理解架构与业务链路；
- AI 逐页撰写（Mermaid 架构图 + 证据引用）→ wiki_write 落盘（frontmatter + git 提交）；
- **写入自动校验**：wiki_write 内置 Mermaid 语法风险清洗（8 类规则，来自生产渲染失败沉淀）+ 证据引用文件存在性校验，返回 warnings；
- wiki_build 一次性把完整构建任务提交给 DSH 子代理（AI 自行完成全部流程）。

知识库写给**下一个 AI 与工程师**——重点是架构决策、业务链路、模块边界，而非流水账。

## 工具

| 工具 | 说明 |
| --- | --- |
| wiki_tree | 浏览项目目录树（模块边界快照），纯 IO |
| wiki_read | 读任意文件内容（有界），纯 IO |
| wiki_write | 把 AI 页面落盘到 vault（frontmatter + git 提交） |
| wiki_build | 提交完整构建任务给 DSH 子代理（AI 主导） |

## 代码更新如何触发 wiki 更新

1. **手动**：`wiki_status project=<目录>` 查同步状态 → `wiki_evolve project=<目录>` 让 AI 只刷新受影响页面（增量，不重建）
2. **自动**：配置 `evolveIntervalMs`（如 600000 = 每 10 分钟）+ `evolveProjects`（项目绝对路径列表），插件定时扫描 git head + 文件 digest，检测到变化自动触发 AI 增量刷新

## 使用

```bash
# 一键：让 AI 通读项目并构建完整知识库
wiki_build project=/path/to/project

# 手工：AI 主导逐步构建
wiki_tree project=/path/to/project
wiki_read project=/path/to/project path=backend/pom.xml
wiki_write project=my-app path=02-后端/订单服务.md body=<AI 撰写的 Markdown>
```

## 配置

```yaml
- insert:
    - id: project-wiki
      name: '/path/to/dsh-project-wiki/lib/index.js'
      config:
        vaultDir: '~/Documents/team-kb'
        kbRoot: '项目知识库'
        injectGuidance: true
        autoCommit: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| vaultDir | ~/Documents/team-kb | Obsidian vault 根目录 |
| kbRoot | 项目知识库 | vault 内知识库根目录名 |
| injectGuidance | true | 首个 step 注入 AI 主导工作流引导 |
| autoCommit | true | wiki_write 默认 git 提交 |
| evolveIntervalMs | 0 | 自动进化轮询间隔（ms）；0 = 关闭自动触发 |
| evolveProjects | [] | 自动监控的项目目录（绝对路径）；代码变化自动触发 wiki_evolve |

## 开发规范（项目宪法）

- **CODE_STANDARDS.md** —— 代码规范总纲（注释中文/架构模式/命名/类型安全/提交规范/审查门禁）
- **AGENTS.md** —— AI 开发守则（铁律 + 完成门禁），任何 AI 写代码前必读
- **门禁**：pnpm check（注释语言 → 类型 → 测试 → 构建，全过才算完成）

## 开发

```bash
pnpm exec tsdown        # 构建 lib/index.js
node node_modules/typescript/bin/tsc --noEmit   # 类型检查
node node_modules/vitest/vitest.mjs run         # 测试
```

## 模块

| 文件 | 职责 |
| --- | --- |
| src/io.ts | 纯 IO 浏览工具（树/读），零解析 |
| src/writer.ts | 页面落盘（frontmatter 戳记/幂等/git 提交） |
| src/build.ts | AI 主导构建编排（DSH 子代理） |
| src/contracts.ts | 工具契约注册 |
| src/index.ts | 工具注册 + 工作流引导注入 |

## License

MIT

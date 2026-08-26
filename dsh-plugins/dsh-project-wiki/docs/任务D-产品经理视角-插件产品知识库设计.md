# dsh-project-wiki 插件产品知识库设计报告（任务D · 产品经理视角）

> 分析对象：**@deepseek-ai/dsh-project-wiki** v0.1.0（DSH 原生插件）
> 证据来源：完整阅读了知识库 5 页（00-README / 01-架构总览 / 02-模块地图 / 03-时序与流程 / 04-API参考）、src/ 全部 6 个源码文件（scanner / diagram / render / evolve / index / types）、项目 README.md、package.json、.wiki-meta.json，并检索了团队记忆与权威知识库（命中本项目 how-it-works 记忆 79eda65c81cc20d5）。

---

# 一、面向的用户是谁？

**一句话定位：DSH（DeepSeek Harness）平台使用者的「免费、自动、1:1 同步」项目知识库生成器——货物是团队共享的活文档，消费者是 AI Agent 与人类开发者。**

## 1.1 三层用户画像

| 用户层 | 是谁 | 核心诉求 | 使用方式 |
| --- | --- | --- | --- |
| **直接用户（工具调用方）** | DSH 会话中的 **AI Agent / 编码助手** | 不猜代码、不看代码全文，快速获得项目结构的**确定性事实**，作为工具决策上下文 | 直接调用 `wiki_scan` / `wiki_generate` / `wiki_evolve` / `wiki_diagram` / `wiki_status` |
| **最终读者（决策受益方）** | 人类开发者 / 团队（Obsidian 使用者） | 打开 vault 就懂项目：入口、模块、依赖、API；新人 onboarding；跨项目检索 | 在 Obsidian 阅读 5 页双链文档 + Mermaid 图 |
| **平台生态（价值放大方）** | DSH 插件生态 / 团队知识管理层 | 让「知识库随代码自动长出来」，沉淀为团队基础设施 | 插件 preset 配置 + 统一 vault 管理 |

## 1.2 用户的真实痛点（从证据反推）

1. **人工文档永远滞后**：手写 wiki 与代码同步成本高，一提交就漂移。
2. **开源 wiki 太重**：Wiki.js / Outline / BookStack 需自建 DB + 服务 + 权限，团队没有运维预算。
3. **AI 描述不可靠**：让 LLM 背述项目会产生幻觉；需要「代码即语言」的结构化事实源。
4. **Obsidian Publish 收费**：公开发布要订阅，团队要的是本地免费方案。

> 关键洞察：这不是 SaaS 产品，而是「装在 AI 工作流里的自助文档基础设施」。用户不打开独立网站，而是在对话里说一句「给这个项目生成知识库」，再打开 Obsidian 看图。

# 二、核心价值主张

> **把项目知识库的维护成本从「人工写」降到「零」——免费、自动、1:1 同步。**

| 支柱 | 主张 | 证据（源码/真实行为） |
| --- | --- | --- |
| **免费** | 零软件授权、零外部 wiki 服务、MIT 开源；Obsidian 免费本地 + Mermaid 原生渲染 | package.json `license: MIT`；README「零收费、零外部 wiki 软件」；diagram.ts「Obsidian 内置渲染=wiki 内置图表能力，零成本」 |
| **自动** | 从代码结构**直接提取**（目录树 / import 依赖 / 导出符号 / 顶层声明），**不从 AI 猜测**；一键生成 5 页 | scanner.ts「code is language」；render.ts 5 页渲染闭环；README「知识库不从 AI 的猜测产生」 |
| **1:1 同步** | 进化由 **git head + 源码 sha256 聚合 digest 双检测**驱动（.wiki-meta.json 快照），代码一变文档立即刷新，幂等不漂移 | evolve.ts `sourceDigestOf` + `evolveWiki` 幂等判断；实测无变化 changed=false、零写入零提交 |

**电梯宣言**：*免费自托管的项目知识库，随代码生长、永不漂移——代码即语言，知识库即代码的影子。*

# 三、理想「插件产品知识库」应包含 8 个板块（设计蓝图）

## 3.1 用户价值（Why）
- **解决什么**：让「看懂一个项目」的成本从小时级降到分钟级；让 AI 拿到结构化事实而非猜测；让团队文档永远跟得上代码。
- **交付什么**：宏观（README/架构）→ 中观（模块地图/流程）→ 微观（API）三层金字塔 + Mermaid 图 + git 可追溯。

## 3.2 目标用户与场景（Who / When）
- **场景 A · 快速上手 / onboarding**：新成员 / 新 AI 会话，`wiki_generate` 一次生成，读 5 页即懂。
- **场景 B · 日常同步**：代码提交后 `wiki_evolve` 增量刷新，文档与 PR 同节奏。
- **场景 C · 团队沉淀**：所有项目 wiki 集中在一个 vault，Obsidian 双链 / 图谱 / 搜索天然可用。
- **场景 D · 深度使用**：`wiki_diagram` 单图复用；`wiki_status` 体检；`force=true` 重建；非 git 仓库由 digest 兜底。

## 3.3 核心功能卡片（What）
| 卡片 | 一句话 | 对应工具 |
| --- | --- | --- |
| 结构扫描 | 零依赖多语言解析 → 输出目录树/依赖/入口/导出/声明 JSON | `wiki_scan` |
| 一键建库 | 宏观→微观 5 页写入 vault + 自动 git 提交 | `wiki_generate` |
| 增量进化 | 代码变了才重生成，幂等、可追溯 | `wiki_evolve` |
| 单图生成 | 架构/依赖/时序/流程 四类 Mermaid 图任意取 | `wiki_diagram` |
| 同步体检 | stale 判断 + 页面清单 + 生成时间 | `wiki_status` |
| 引导注入 | 首个 step 自动注入 wiki 工作流引导（可关） | injectGuidance |

## 3.4 使用流程（How）
- **快速上手（1 分钟）**：配置好插件 → `wiki_generate project=<目录>` → 打开 Obsidian 看 5 页。
- **日常使用（循环）**：提交代码 → `wiki_evolve project=<目录>`（只在实际变化时刷新）→ 需要时 `wiki_status` 体检。
- **高级用法**：`wiki_diagram type=sequence/flow file=<文件>` 针对单文件/入口出图；`commit=false` 只写不提交；`force=true` 强制重建；非 git 仓库靠 digest 仍可进化。

## 3.5 配置指南（Setup）
`cordis.patch.yml` 追加到 `~/.dsh/profiles/<profile>/cordis.patch.yml` 后重启：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| vaultDir | `~/Documents/team-kb` | Obsidian vault 根目录 |
| kbRoot | `项目知识库` | vault 内知识库根目录名 |
| injectGuidance | `true` | 首个 step 注入 wiki 工作流引导 |
| autoCommit | `true` | 生成/进化后自动 git 提交 |

## 3.6 常见问题（FAQ）
- **Q1 evolve 说没变化但代码明明改了？** → 检测 = git head + 源码 digest 双保险；同一 commit 内再改由 digest 兜底；仍可 `force=true`。
- **Q2 项目不是独立 git 仓库？** → 仍可用：digest 检测不依赖 git 独立性（evolve 正是为此设计，避免 git diff 误判）。
- **Q3 生成的 wiki 会被 evolve 覆盖我的手工编辑吗？** → 会：这 5 页是自动生成的契约页；手工内容请放在项目 README 或独立笔记。
- **Q4 支持哪些语言？** → 常见 20+ 扩展名（TS/JS/Python/Java/Kotlin/Go/Rust/PHP/Ruby/C/C++/C#/Swift/Vue/Svelte/SQL/Shell/YAML…），正则级解析、零运行时依赖。
- **Q5 大仓库会不会卡？** → 单文件 256KB 上限、SKIP_DIRS（node_modules/dist/.git…）+ SKIP_EXTS 过滤、架构图最多 80 条边。

## 3.7 版本演进 / 变更日志（Changelog）
- **v0.1.0（当前）**：扫描 → 5 页渲染 → digest 进化闭环；5 个工具；pre-step 引导注入；MIT。
- **演进方向（roadmap 待定）**：配置页自动生成（从 Config schema）、工具卡片页、changelog 页（从 git log）、成功指标统计、多项目索引页。
- **现状基础设施**：.wiki-meta.json 已记录每个 wiki 页的 sha256 与 git head；每次生成自动 git 提交（消息含时间戳 + git head）——机器可追溯已就绪，缺面向人的 changelog 页。

## 3.8 成功指标（Metrics）
| 指标 | 口径 | 现状基线（证据） |
| --- | --- | --- |
| 建库成本 | 从零到 5 页 wiki 的耗时/调用数 | 1 次 `wiki_generate`（实测对 dsh-obsidian / dsh-project-wiki 均成功） |
| 同步保鲜率 | `wiki_status` stale=false 的时间占比 | digest 幂等实测 changed=false（无变化零写入零提交） |
| evolve 效率 | 无变化时的写入/提交次数 | 0（幂等跳过） |
| 覆盖率 | 已建库项目 / 团队项目总数 | 目前仅 2 个项目已生成 |
| 使用频次 | wiki_* 工具周调用次数 | 无埋点，需后续统计 |
| 内容可信度 | API 签名/行号与代码一致性 | 1:1 由构造保证（扫描即代码） |
| 时效偏差 | 页面 git_head 与代码 git_head 不一致时长 | `wiki_status` 可即时给出 stale 状态 |

# 四、逐项对比：理想知识库 vs 现有 5 页

## 4.1 结论速览表

| 理想板块 | 现有覆盖 | 差距 | 能否自动生成 |
| --- | --- | --- | --- |
| ① 用户价值 | ❌ 无（00 页仅一句「自动生成/随代码进化」） | 缺价值主张/痛点/免费对比 | **需人工** |
| ② 目标用户与场景 | ❌ 无 | 缺画像与场景 | **需人工** |
| ③ 核心功能卡片 | ⚠️ 半（README 有工具表；index.ts defineTool description 有描述） | 缺产品语态功能卡片话术 | **可自动**（从工具注册表提取，话术需润色） |
| ④ 使用流程 | ⚠️ 半（README 3 步简述 + guidance 注入短句） | 缺快速上手/日常/高级三档分层 | **半自动**（模板 + 人工撰写一次） |
| ⑤ 配置指南 | ⚠️ 半（README 手写表；index.ts Config schema 有注释） | 知识库内无配置页 | **可自动**（Config z.object 可编程渲染，建议下版落地） |
| ⑥ 常见问题 | ❌ 无（踩坑经验散落在团队记忆） | 缺 FAQ 页 | **需人工**（素材已就绪，半小时可整理） |
| ⑦ 版本演进/变更日志 | ⚠️ 弱（仅 .wiki-meta.json 机器快照 + git 历史） | 缺面向人的 changelog 页 | **半自动**（git log + meta 可生成；首版需人工） |
| ⑧ 成功指标 | ❌ 无 | 缺指标定义与基线 | **需人工**（定义口径）+ **半自动**（stale/页面数据已可采集） |

## 4.2 现有 5 页各自的覆盖情况

| 页 | 层级 | 已自动生成内容 | 覆盖的理想板块 | 缺什么 |
| --- | --- | --- | --- | --- |
| 00-README.md | 宏观 | 项目概览（规模/入口/模块数）、技术栈表、5 页双链导航、frontmatter | 弱覆盖用户价值（仅声明式） | 价值主张、目标用户、使用流程、配置、FAQ、指标 |
| 01-架构总览.md | 宏观 | 模块架构图（graph LR）+ 模块依赖图（flowchart TD）+ 入口调用链时序图（BFS） | 技术面完整 | 无产品视角内容（纯技术页，正常） |
| 02-模块地图.md | 中观 | 每模块：文件表（文件/行数/语言/主要声明）+ 导出符号清单 | 技术面完整 | 无 |
| 03-时序与流程.md | 中观 | 入口时序图 + 最繁忙 5 文件的声明流程序列图 | 技术面完整 | 无 |
| 04-API参考.md | 微观 | 全部 64 条声明：定义/文件:行号/类型/JSDoc 说明 | 技术面完整 | 无 |

**核心优势（对比验证）**：每页带 frontmatter（created/updated/author/project/git_head/tags，遵循 obsidian-knowledge-git 契约）+ 全 Mermaid（Obsidian 原生渲染）——这本身已是「宏观→微观」金字塔的完整骨架，5 页双链可达。

## 4.3 差距分析：哪些能自动生成、哪些必须人工补充

### ✅ 可以自动生成（建议下一版引擎落地，形成「5+N」页或并入 00）
1. **配置指南页（最高性价比）** — 从 `Config`（index.ts: z.object）遍历键/默认值/schema 注释直接渲染表格；README 手写表可删除。
2. **功能卡片页** — 从 5 个 defineTool 的 name/description/parameters 注册表自动提取工具清单表格。
3. **changelog 页** — 复用 .wiki-meta.json + 扫描项目 git log，自动输出「vX.Y.Z / 日期 / git head / 变更摘要」。
4. **成功指标数据** — wiki_status 已能输出 stale/页面清单，可扩展生成次数/演进次数等统计字段。

### ✍️ 必须人工补充（产品/文档层，代码无法导出）
1. **用户价值主张页**（电梯宣言 + 3 大支柱 + 与开源 wiki 对比表——素材已在 README「为什么不用开源 wiki」）。
2. **目标用户与场景页**（三层画像 + A/B/C/D 场景）。
3. **FAQ 页**（从团队记忆 79eda65c81cc20d5 + 源码行为提炼 5-8 条，半小时可完成）。
4. **成功指标定义**（口径 + 目标值，需团队确认）。
5. **快速上手 walkthrough**（带命令行示例的引导页，一次撰写长期复用）。

> **反过来说**：现有 5 页已经把「微观事实层」全部自动化了，缺的是「包装层」（价值/场景/FAQ/指标）——这些恰好是产品经理该写的部分，也是提升插件采用率的关键。

# 五、落地建议（下个版本 mini-roadmap）

1. **立即（人工，本周）**：在项目 README 或 vault 建「产品说明」笔记，补齐 ①②⑥⑧（成本 < 1 天，素材全部现成）。
2. **短期（插件 v0.2）**：render.ts 增加 `configPage`（从 Config schema 自动渲染配置表）+ `toolsPage`（从工具注册表渲染功能卡片），随 evolve 自动保鲜。
3. **中期（插件 v0.3）**：`changelogPage` 从 git log + meta 自动生成；`wiki_status` 输出计入成功指标字段。
4. **永远人工（产品层）**：价值主张、用户场景、FAQ 迭代、指标复盘——与人相关的内容交给文档所有者，不被自动生成覆盖。

---

*报告完。证据链：知识库 5 页全文、src/ 全部源码、README.md、package.json、.wiki-meta.json、团队记忆 79eda65c81cc20d5。*

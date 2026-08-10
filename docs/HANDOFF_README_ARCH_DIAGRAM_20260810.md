# 交接：README 增加架构总览章节

> 日期：2026-08-10
> 提交：`98b1fd0`（master，已 push 远程）

## 1. 任务背景与需求

用户反馈 README.md 只有干巴巴的文字，没有架构图，读者难以理解项目怎么用。
要求给 README 增加架构图页，让用户一眼看懂系统组成和使用路径。

## 2. 已完成内容

README.md 新增「## 架构总览」章节（位于简介之后、安装之前），包含：

1. **一句话定位**：AI 客户端 → cerebrate-mcp → 脑虫服务端 → 共享存储
2. **系统架构图**（Mermaid `graph TB`）：四层（① AI 客户端 / ② cerebrate-mcp / ③ 脑虫服务端 / ④ 存储层）
3. **各层职责表**（Markdown 表格）
4. **接入使用流程**（Mermaid `flowchart LR`）：安装 → 配置 → 接入客户端 → 会话使用；新用户分支（注册 → 扫码绑定 → 拿 token）
5. 顺手修正过时信息：MCP 工具数 29 → **43**（以 mcp.js 实际工具数为准）

## 3. 关键决策与理由

- **用 Mermaid 而非图片**：GitHub / VS Code / 各种 Markdown 预览原生渲染，零二进制资产、可 diff、可维护；项目 docs/SEQUENCE_DIAGRAMS.md 已有 Mermaid 先例。
- **两张图分工**：架构图回答「系统由什么组成」，流程图回答「从零开始怎么用」，正好覆盖用户「不知道怎么用」的痛点。
- **置于文档顶部**：README 读者第一眼先看到图再看到命令，符合「先理解再动手」。
- **修正 29→43**：有证据（mcp.js 中 `name: "cerebrate_*"` 工具定义数 = 43），不是拍脑袋。

## 4. 验证证据

- Mermaid 官方解析器验证：`mermaid.parse()` 对两张图均返回 OK（Node 22 + jsdom + mermaid 11）。
- `git diff --stat`：README.md +64/-1，改动聚焦。
- git 已提交并 push：`fe7e52a..98b1fd0 -> master`。

## 5. 遗留问题

- README 中「默认（http://127.0.0.1:8765）」与 mcp.js 内置默认云端 ngrok 地址不一致——README 说的是本地默认，mcp.js 实际 `DEFAULT_SERVER_URL` 已是 ngrok 域名。若要让 README 与代码完全一致，需在配置优先级段落补一句「安装后默认连内置云端地址」。本次未改，属遗留。
- README 标题为「Cerebrate MCP Server (Node.js)」，与仓库内 Python 服务端并存，架构图只覆盖了 MCP 接入视角，未覆盖 Python 服务端完整模块（server/memory/core/brain）。如需全量架构图，可参考 AGENTS.md「项目边界」扩一张服务端内部架构图。

## 6. 下一步建议

1. 在 GitHub 页面确认两张 Mermaid 图渲染正常（浏览器打开 README 即可）。
2. 如 README 定位是「对外 MCP 接入文档」，可把「配置优先级」段的默认地址描述与 mcp.js 对齐。
3. 如需服务端内部架构，另加一张 brain/server/memory/core 分层图（素材在 AGENTS.md）。

## 7. 关键文件与命令索引

- 改动文件：`README.md`
- 验证命令（Node 22 + jsdom + mermaid@11）：
  ```bash
  mkdir -p /tmp/mmd-verify && cd /tmp/mmd-verify
  npm i mermaid jsdom
  # 脚本要点：先设 global.window/document/Element 等，再动态 import('mermaid')
  # 原因：mermaid 模块加载时即初始化内置 DOMPurify（purify = createDOMPurify()），
  #       缺 window/Element 会导致 DOMPurify.sanitize is not a function
  ```
- 注意：`@mermaid-js/parser`（langium）不支持 flowchart/graph 图类型，验证 flowchart 必须用完整 mermaid 包。

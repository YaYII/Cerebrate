# @deepseek-ai/dsh-obsidian

Obsidian 团队知识库客户端插件（DSH 原生插件，**全程无 MCP**）：通过
Obsidian Local REST API 直连本地团队 Vault，并桥接 Brain Server 团队权威
知识库。AI 可以直接读/写/搜索团队知识文件，与脑虫的**过程记忆**（cerebrate_*）
形成互补——记忆与知识库是两个明确区分的概念。

## 设计与架构

    DSH（AI 工作区）
     ├─ dsh-obsidian 原生插件（defineTool，无 MCP）
     │    ├─ obsidian_*   → 本地 Obsidian Vault（纯 Markdown 文件层）
     │    └─ knowledge_*  → Brain Server 团队权威知识库（向量语义检索）
     ├─ dsh-memory-cerebrate（已有）
     │    └─ cerebrate_*  → 团队过程记忆（经验/决策/踩坑）

两个知识载体分工明确：
- **Obsidian Vault**（obsidian_*）= 团队**原始知识库文件层**：纯 Markdown、
  双向链接、图谱、本地优先、可 Git 同步。
- **Brain /v1/knowledge**（knowledge_*）= 团队**权威检索知识库**：
  向量语义检索、policy/verified 权威标记、跨成员共享。

## 配置

    - insert:
        - id: dsh-obsidian
          name: '@deepseek-ai/dsh-obsidian'
          config:
            baseUrl: 'https://127.0.0.1:27124'   # Obsidian Local REST API（自签 HTTPS）
            apiKeyEnv: 'OBSIDIAN_API_KEY'          # Obsidian API key 环境变量
            apiKeyFile: '~/.obsidian/api-key'      # 或本地文件（JSON {"apiKey": ...}）
            brainUrl: 'http://127.0.0.1:8765'      # Brain Server
            brainTokenEnv: 'CEREBRATE_SERVER_TOKEN' # Brain token（master 或 user）
            user: 'yangying'
            agentId: 'dsh'
            injectGuidance: true

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| baseUrl | https://127.0.0.1:27124 | Obsidian Local REST 安全端口 |
| apiKeyEnv / apiKeyFile | OBSIDIAN_API_KEY / ~/.obsidian/api-key | Obsidian API key 来源 |
| tlsRejectUnauthorized | false | 接受自签证书（Local REST API 默认自签） |
| brainUrl | http://127.0.0.1:8765 | Brain Server |
| brainTokenEnv / brainTokenFile | CEREBRATE_SERVER_TOKEN / ~/.cerebrate/token | Brain token 来源 |
| injectGuidance | true | 首个 step 注入知识优先引导 |
| autoStart | true | 插件加载时若 Obsidian REST 不可达则自动拉起（自愈） |
| obsidianBin | ~/bin/obsidian-deb/opt/Obsidian/obsidian | 自动拉起用的 Obsidian 可执行文件路径 |
| launchTimeoutMs | 45000 | 等待自动拉起的 Obsidian 提供服务的时间上限 |

## 自愈（autoStart）

插件加载时会探测 Obsidian REST API；若不可达（服务被清理/崩溃/机器重启后未拉起），自动
`spawn` 一个本地 Obsidian 进程（带 DISPLAY / XAUTHORITY 等环境，脱离会话）并等待端口恢复。
因此 **Obsidian 是否常住不依赖任何手动 systemd 配置或会话终端**——插件自身确保其依赖可用。
在线时不重复拉起（Obsidian 单实例，避免多实例竞争）。

## Git 版本管理（时间戳 + 版本化，防信息失效）

Vault（~/Documents/team-kb）已 git init，并安装 obsidian-git 插件（v2.39.0）。
信息有效性契约：**每次写入知识 = 带时间戳的 git commit；每次读取 = 报最后更新时间**。

- 写入带 frontmatter `created/updated/author`；更新保留 created、只改 updated
- 写入后触发 commit：obsidian-command_run `obsidian-git:commit`（消息自动为 `vault backup: <时间戳>`）
- 读取/追溯更新时间：`cd ~/Documents/team-kb && git log --date=format:'%Y-%m-%d %H:%M:%S' -- <path>`
- API key 存于插件 data.json，已通过 .gitignore 排除不入库
- 完整工作流见技能 `obsidian-knowledge-git`（~/.agents/skills/）

## 工具

**Obsidian 文件层（vault）**
- obsidian_status — 连接状态检查
- obsidian_list — 列出目录文件
- obsidian_read — 读笔记全文
- obsidian_write — 写/覆盖笔记
- obsidian_append — 追加到笔记（PATCH content append）
- obsidian_search — 全文搜索（/search/simple/）
- obsidian_commands — 列出可用命令
- obsidian_command_run — 执行命令
- obsidian_open — 在 Obsidian UI 打开笔记

**Brain 权威知识库**
- knowledge_search — 向量语义检索团队权威知识
- knowledge_store — 存入团队权威知识（分层权限）

## 记忆 vs 知识库（两个概念，务必区分）

| 维度 | 记忆（cerebrate_*） | 知识库（obsidian_*/knowledge_*） |
| --- | --- | --- |
| 本质 | 过程经验/决策/踩坑 | 权威文档/策略/项目事实 |
| 载体 | Brain 虫群记忆（向量+共识） | Obsidian 文件 + Brain 权威知识库 |
| 生命周期 | 提议→共识→进化 | 直接沉淀→检索→权威标记 |
| 写入 | cerebrate_propose | obsidian_write / knowledge_store |
| 检索 | cerebrate_search | obsidian_search / knowledge_search |

工作流：先 obsidian_search 查文件知识库 → 仍缺再 knowledge_search 查权威
知识库 → 都无再独立解决 → 结论用 obsidian_write 落文件知识库 → 确属团队级
权威知识再 knowledge_store 沉淀。

## Obsidian ↔ Brain 同步桥

scripts/sync-vault-to-brain.mjs 把 Vault 笔记按 frontmatter 语义沉淀进 Brain
团队权威知识库（插件化，无 MCP）：

    OBSIDIAN_API_KEY=xxx CEREBRATE_MASTER_TOKEN=xxx \
      node scripts/sync-vault-to-brain.mjs --root "团队知识库" --dry-run

- frontmatter tags → topics；project → project_id；scope → scope
- authoritative: true 或路径含 /_policy/ → 权威文档（需 admin token）
- 普通笔记 → 普通知识（user token 即可）

## 开发

    pnpm typecheck   # tsc --noEmit
    pnpm test        # vitest（工具注册、REST 请求、路径编码）
    pnpm build       # tsdown → lib/

## License

MIT

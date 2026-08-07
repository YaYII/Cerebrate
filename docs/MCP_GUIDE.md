# Cerebrate MCP 使用指南（同事接入版）

> 脑虫记忆系统 MCP 客户端：把团队记忆接入你的 AI 助手（Codex / Claude Code / Qoder / opencode）。
> 当前版本 **cerebrate-mcp 5.2.2**（npm 标准安装，Node 16+，零依赖）。
> 2026-08-07 更新：内置默认云端地址 → 零配置直连；自助注册 + Authenticator 绑定（不再由管理员发 token）。

---

## 1. 这是什么

Cerebrate 是团队共享的 AI 记忆中枢（服务端由管理员部署）。本 MCP 客户端让你的 AI 助手：

- **读**：搜索/感知团队记忆（技术经验、项目知识、决策记录）
- **写**：把解决问题的经验沉淀到团队记忆（他人可复用）
- **协作**：项目业务画像、多人工作声明、记忆投票
- **认证**：你的身份由「用户名 + Authenticator 动态码」绑定，token 本地保存

## 2. 一键安装（本机直接安装，Node 首选）

```bash
# 首次安装（npm 官方渠道，正规）
npm install -g cerebrate-mcp@latest
```

> **零配置直连云端**：mcp 已内置默认云端脑虫地址，安装后无需配置 URL，
> 直接进入下一步注册绑定即可。地址变化只需重跑
> `cerebrate-mcp setup --url <新地址>`（见第 7 节常见问题）。

> **为什么本机直接安装**：MCP 包含本地实体化抽取与用户代码库分析（harvest）能力，需要访问本机文件系统，容器化会隔离这些能力。地址变化只需重跑 `cerebrate-mcp setup --url <新地址>`。

## 3. 注册 + 绑定身份（防投毒，必须做）

每个用户用自己的「用户名 + 手机 Authenticator」绑定身份，token 只保存在自己本地。
**管理员不发放 token**，避免 token 流转泄露、他人伪装投毒。

```bash
# ① 注册（首次，拿到绑定二维码网页）
# 在你的 AI 客户端对话里，让助手调用 MCP 工具：
#   cerebrate_auth_register { "username": "<你的用户名>" }
```

> 用户名须 3-32 位小写字母/数字/下划线/连字符。

```text
② 浏览器打开工具返回的 bind_url → 手机安装「Authenticator」App → 扫网页上的二维码完成绑定
```

```bash
# ③ 登录（输入 Authenticator 当前 6 位动态码，token 自动保存本地，长期有效）
cerebrate-mcp login --username <你的用户名> --code <6位码>
```

> 换机/重装后：只需重跑 ③ 登录（同一用户名 + 新 6 位码），无需重新注册。

## 4. 配置到你的 AI 客户端（二选一）

`setup` 最后会打印对应片段，粘贴即可：

| 客户端 | 位置 |
|---|---|
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.cerebrate] url = "https://<域名>/cerebrate/v1/mcp"`（token 走本地文件，无需手填） |
| Claude Code | `claude mcp add --transport http cerebrate https://<域名>/cerebrate/v1/mcp`（token 走本地文件；推荐，零本地服务） |
| Qoder | stdio：命令 `npx -y cerebrate-mcp@latest`，env 走 `CEREBRATE_SERVER_URL` / `CEREBRATE_SERVER_TOKEN` |
| opencode | 同上（stdio） |

stdio 客户端（Qoder / opencode / Trae）也可直接用 `npx -y cerebrate-mcp@latest` 运行，无需全局安装。

> ⚠️ 请务必带 `@latest`：漏写会命中 npx 本地缓存拿到旧版本（实测会回到 5.0.x）。若仍怀疑版本旧，先 `npm cache clean --force` 再运行。

## 5. 开始使用

重启 AI 客户端，新对话里先让它调用 `cerebrate_sense`（感知记忆），之后：

```text
你：查一下之前有没有「docker 部署脑虫」的经验
AI：调用 cerebrate_search → 返回相关记忆

你：我刚解决了 X 问题，记住这个经验
AI：调用 cerebrate_propose → 沉淀到团队记忆
```

## 6. 工具清单（43 个）

### 🟢 读 / 日常（最常用）
| 工具 | 用途 |
|---|---|
| `cerebrate_sense` | 【会话开始必调】感知脑虫状态、记忆概览、调度建议 |
| `cerebrate_search` | 渐进式检索第 1 层：紧凑索引（省 token） |
| `cerebrate_timeline` | 第 2 层：某记忆的前因后果 |
| `cerebrate_detail` | 第 3 层：按需取完整详情 |
| `cerebrate_query` | 决策查询：reuse/verify/new_experience |
| `cerebrate_doctrines` | 读取权威教条/灵魂准则 |
| `cerebrate_help` / `cerebrate_assess` / `cerebrate_stats` | 帮助 / 元认知评估 / 统计 |
| `cerebrate_knowledge_search` | 知识库检索 |
| `cerebrate_project_context` | 项目浓缩上下文 |
| `cerebrate_project_profile` | 业务画像（数据世界+流程世界） |
| `cerebrate_project_navigate` | 画像导航定位代码入口 |
| `cerebrate_recall` | 个人偏好 |
| `cerebrate_auth_status` | 查看登录态 |

### 🟡 写 / 协作（贡献与互动）
| 工具 | 用途 |
|---|---|
| `cerebrate_propose` | 【贡献】沉淀经验/教训到团队记忆 |
| `cerebrate_propose_skill` / `cerebrate_propose_lesson` | 技能/教训（兼容旧接口） |
| `cerebrate_entity_extract` | 本地实体抽取（数据不离开本地） |
| `cerebrate_vote` | 给记忆投票（共识治理） |
| `cerebrate_use_start` / `cerebrate_use_finish` | 记忆复用跟踪 |
| `cerebrate_remember` | 写入个人偏好 |
| `cerebrate_project_work` | 多人协作声明（claim/release） |
| `cerebrate_auth_login` / `cerebrate_auth_logout` | 登录（用户名+6位码）/登出 |

### 🔴 管理（服务端管理员保护，普通用户会 403）
| 工具 | 说明 |
|---|---|
| `cerebrate_auth_register` / `cerebrate_auth_rebind` | 注册新用户 / 重新生成绑定链接 |
| `cerebrate_batch_process` / `cerebrate_ingest` / `cerebrate_knowledge_store` | 批量处理 / 文档吸入 / 知识写入 |
| `cerebrate_project_harvest` | 代码结构推送到画像 |
| `cerebrate_register` | 注册 AI 代理身份 |

> 服务端已做管理员角色隔离：普通用户调用管理端点返回 403（防止篡改灵魂、泄露用户列表、触发付费蒸馏等）。

## 7. 认证与权限

- **读共享**：所有人可读团队记忆
- **写需身份**：写记忆用你的 token 确定 owner，只能管理自己写的
- **投票放开**：可给他人记忆投票（共识晋升）
- **查询优先自己**：搜索时自己的记忆排前
- **token 是唯一凭证**：妥善保存；换机后在你的机器上跑一次登录即可

## 8. 常见问题

**Q: 401 unauthorized？**
先 `cerebrate-mcp status` 看登录态；未登录则跑 `cerebrate-mcp login --username <用户名> --code <6位码>`。

**Q: 连接超时 / 地址变了？**
脑虫公网地址由隧道提供，重启可能变化——向管理员要最新 URL，重跑 `cerebrate-mcp setup --url <新地址>` 覆盖内置默认值即可。

**Q: 换电脑 / 重装系统？**
重新 `npm install -g cerebrate-mcp@latest` → `cerebrate-mcp login --username <用户名> --code <Authenticator 当前码>`（token 重新保存本地）。

**Q: 调用报 403 admin required？**
该工具是管理员功能，普通用户不可用（属正常）。

**Q: 需要装 Python 依赖吗？**
不需要。MCP 客户端纯标准库；只有高级工具（如 harvest 本地代码分析）也用标准库 AST。

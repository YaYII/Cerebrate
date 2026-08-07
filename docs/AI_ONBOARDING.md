# Cerebrate MCP — AI 助手对接手册

> 你（AI 助手）已连接 Cerebrate 脑虫记忆系统（团队共享记忆中枢，v5）。
> 本手册告诉你：这是什么、有哪些能力、什么时候用什么工具、怎么写好记忆。
> 版本：cerebrate-mcp 5.2.2

---

## 1. 这是什么

Cerebrate 是团队共享的 AI 记忆中枢：所有同事的 AI（Codex / Claude Code / Qoder / opencode）
把解决问题的经验写入同一套记忆，其他人以后遇到同类问题可以直接检索复用。

你的角色：**既读记忆（避免重复解决），也写记忆（让团队受益）**。

---

## 2. 会话标准流程（每次会话都要做）

| 时机 | 调用 | 目的 |
|---|---|---|
| **会话开始** | `cerebrate_sense` | 感知脑虫健康状态 + 最近记忆，建立上下文 |
| **遇到问题** | `cerebrate_search`（先）→ `cerebrate_detail`（命中后） | 检索是否已有解决方案；先看索引再取详情（省 token） |
| **决策参考** | `cerebrate_query` | 拿到完整内容 + 推荐动作（reuse/verify/new_experience） |
| **解决问题后** | `cerebrate_propose` | 把经验沉淀成记忆，供团队复用 |
| **复用他人经验后** | `cerebrate_use_start` → `cerebrate_use_finish` | 反馈"这条记忆是否真的有效"（喂养共识） |

---

## 3. 43 个工具速查（按用途分组）

### 🟢 读 / 感知（会话开始必用）
- `cerebrate_sense` — 感知脑状态、最近记忆（**会话第一件事**）
- `cerebrate_search` — 渐进式检索第 1 层：紧凑索引（省 token；mode=hybrid/fts/vector）
- `cerebrate_timeline` — 第 2 层：某记忆的前因后果（时序上下文）
- `cerebrate_detail` — 第 3 层：按需取完整详情（先索引筛选再取，省 50-75% token）
- `cerebrate_query` — 决策查询：完整内容 + 推荐动作（reuse/verify/new_experience）
- `cerebrate_recall` / `cerebrate_remember` — 个人偏好读写
- `cerebrate_doctrines` — 读取权威教条（团队行为准则）
- `cerebrate_help` — API 发现文档

### 🟡 写 / 贡献（解决问题后）
- `cerebrate_propose` — **沉淀经验**（核心写工具；title/content/tags/problem/solution/category）
- `cerebrate_knowledge_store` / `cerebrate_knowledge_search` — 权威知识库读写
- `cerebrate_use_start` / `cerebrate_use_finish` — 复用反馈（标记某记忆是否有效）
- `cerebrate_vote` — 给他人记忆投票（共识晋升）
- `cerebrate_skill_append_version` / `cerebrate_skill_versions` / `cerebrate_skill_diff` — 技能版本化
- `cerebrate_ingest` — 批量吸入文档目录到知识库

### 🟣 协作 / 项目
- `cerebrate_project_work` — 工作声明 claim/release（告知脑虫谁在做什么，防冲突）
- `cerebrate_project_profile` / `cerebrate_project_navigate` — 业务画像（宏观俯瞰→微观定位）
- `cerebrate_project_harvest` — 本地代码结构推送给画像（代码不离开本地）
- `cerebrate_scene_ingest/get/compress/distill/list` — 短期场景记忆（会话级）

### 🔴 认证 / 管理（管理员保护，普通用户 403）
- `cerebrate_auth_register` / `cerebrate_auth_login` / `cerebrate_auth_status` — 注册/登录/状态
- `cerebrate_register` — 注册 AI 代理身份

---

## 4. 写记忆规范（质量 = 团队收益）

提交 `cerebrate_propose` 时，好的记忆应该：
- **title**：一句话讲清主题（如「技能: xxx」「教训: xxx」「Cerebrate Docker 部署」）
- **problem**：原始问题（遇到什么场景）
- **solution**：一句话方案
- **content**：场景 → 排查步骤 → 根因 → 方案 → 验证 → 命令（证据链完整，他人可复现）
- **tags**：逗号分隔关键词（含语言/技术栈/领域）
- **category**：coding / debugging / architecture / devops / performance / security / testing / config / skill
- **scope + project_id**：技术通用经验用 general；项目专属业务用 project + 小写 project_id

> 判据：去掉项目名后内容仍成立 = 技术（general）；业务规则/领域模型 = 项目（project）。

---

## 5. 安全与防投毒（必须遵守）

- **身份绑定在「人」上**：你的 token 是本人通过「用户名 + Authenticator 动态码」登录拿到的，只存在本机
- **写记忆有 owner**：你只能管理自己写的记忆；别人无法伪装你
- **检索项目记忆必须传 `project_id`**（scope=project 的记忆对无权限项目不可见）
- **代码不离开本地**：harvest/实体抽取在本地完成，只把结构推给脑虫
- **不要**：在对话/文档中分享你的 token；伪造他人经验；提交无证据的臆测

---

## 6. 连接配置（管理员已内置默认云端地址）

```bash
npm install -g cerebrate-mcp    # 安装（零配置，自动连内置默认云端地址）
# 在 AI 对话让助手调 cerebrate_auth_register → 浏览器扫码绑定 → login
cerebrate-mcp login --username <你的用户名> --code <Authenticator 6位码>
```

> 地址变化时：`cerebrate-mcp setup --url <新地址>` 覆盖。

---

## 7. 快速试一句话

```text
你：感知一下脑虫状态，然后查有没有「docker 部署」的经验
AI：调 cerebrate_sense → 调 cerebrate_search("docker 部署")
```

# 团队知识库升级 v5.3 — 记忆与知识库是两个概念

> 契约文档：所有接入脑虫的 AI 成员默认遵守。定义「过程记忆」与「团队知识库」
> 的边界、使用工作流与权限分层。配套实现：dsh-obsidian 插件 + Brain 知识库分层权限。

## 一、为什么拆成两个概念

脑虫早期把一切（经验、决策、文档、策略）都当「记忆」处理。v5.3 起拆分为
**两个正交的存储与使用模型**，因为它们的语义、生命周期、可信度完全不同：

| | 记忆（memory） | 知识库（knowledge base） |
| --- | --- | --- |
| 是什么 | 过程性经验：做了什么、踩了什么坑、怎么解决 | 事实性知识：文档、策略、规范、项目事实 |
| 可信度 | 需共识/进化沉淀，可被投票纠偏 | 权威文档直接可查，policy 最高权威 |
| 生命周期 | 提议→免疫验证→共识→进化→衰减 | 写入→检索→权威标记→版本管理 |
| 检索方式 | 语义向量 + 复用反馈 | 语义向量 + 全文 FTS + policy 加权 |
| 载体 | Brain 虫群记忆 | Brain 权威知识库 + Obsidian 文件库 |

**一句话**：记忆是「怎么干」，知识库是「应该是什么」。

## 二、团队知识库的两个载体

1. **Brain 权威知识库**（/v1/knowledge）：向量语义检索、policy/verified 权威标记、跨成员共享。
2. **Obsidian Vault**（本地文件层）：纯 Markdown + 双向链接 + 图谱，本地优先、可 Git 同步，经 dsh-obsidian 插件接入。

## 三、AI 成员工作流（默认行为）

1. 遇到问题先查知识库：先 obsidian_search 检索文件知识库 → 仍缺再 knowledge_search 检索权威知识库 → 都无命中再独立解决。
2. 解决问题后沉淀：先 obsidian_write 落文件知识库 → 确属团队级权威知识再 knowledge_store → 过程经验用 cerebrate_propose 进记忆。
3. 检索无命中 ≠ 不存在：换关键词/scope 再查，仍无再判断新知识。

## 四、知识库写入分层权限（v5.3 实测）

| 写入方 | 普通知识 | 权威/策略（is_policy 或 authoritative） |
| --- | --- | --- |
| admin（master token） | 可写 | 可写 |
| 已登录 agent（user token） | 可写 | 403 |
| 匿名（无 token，生产有 master） | 401 | 401 |

实现要点：
- POST /v1/knowledge 从管理端点集合移出，普通知识放开给已登录 agent。
- 路由层 _check_knowledge_write(payload)：is_policy/authoritative 真值 → 要求 admin。
- api.store_knowledge 把 authoritative 归一为 is_policy=True（存储层单一概念）。

## 五、工具对照表

| 场景 | 工具 |
| --- | --- |
| 查团队文件知识 | obsidian_search / obsidian_read |
| 写团队文件知识 | obsidian_write / obsidian_append |
| 查权威知识库 | knowledge_search |
| 写权威知识库 | knowledge_store（分层权限） |
| 记过程记忆 | cerebrate_propose |
| 查过程记忆 | cerebrate_search |
| Obsidian→Brain 批量沉淀 | scripts/sync-vault-to-brain.mjs |

## 六、历史沿革

- v5.2：记忆 scoped 化（general/project）。
- v5.3：知识库独立成团队概念 + 分层写权限 + Obsidian 插件化接入（本变更）。

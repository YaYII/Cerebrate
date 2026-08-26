# @deepseek-ai/dsh-memory-cerebrate

Cerebrate (虫群) 团队记忆客户端插件：通过 Brain Server REST API 直连本地/远程虫群记忆服务，注册原生 `cerebrate_*` 工具，并在首个 agent step 注入"记忆优先"引导，让模型在行动前先检索团队共享记忆、解决问题后沉淀经验。

## 为什么是原生插件而非 MCP

- 工具直接注册进 harness 工具注册表，模型请求零转换开销。
- 工具数量与描述完全可控（MCP 桥会把全部 30+ 工具一股脑暴露）。
- 记忆引导注入（`injectMemoryGuidance`）让团队记忆真正进入 agent 工作流，而不只是"可用"。

## 配置

```yaml
- insert:
    - id: memory-cerebrate
      name: '@deepseek-ai/dsh-memory-cerebrate'
      config:
        baseUrl: 'http://127.0.0.1:8765'
        tokenEnv: 'CEREBRATE_SERVER_TOKEN'
        tokenFile: '~/.cerebrate/token'
        user: 'yangying'
        agentId: 'dsh'
        injectMemoryGuidance: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8765` | Brain Server 地址，不带尾部斜杠 |
| `tokenEnv` | `CEREBRATE_SERVER_TOKEN` | Bearer token 环境变量名（优先） |
| `tokenFile` | `~/.cerebrate/token` | token 文件（JSON `{ "token": ... }` 或裸文本），环境变量缺省时读取 |
| `user` | `yangying` | 个人记忆（recall/remember）与决策查询的默认用户 |
| `agentId` | `dsh` | search/propose 记录到虫群的代理标识 |
| `injectMemoryGuidance` | `true` | 是否在首个 agent step 注入团队记忆引导 |

## 工具

- `cerebrate_sense` — 感知脑状态（会话开始）
- `cerebrate_search` — 记忆索引检索（遇到问题的第一步）
- `cerebrate_timeline` — 记忆时序上下文
- `cerebrate_detail` — 按 id 取完整记忆详情
- `cerebrate_query` — 决策查询（reuse/verify/new_experience）
- `cerebrate_propose` — 沉淀团队记忆（解决问题后）
- `cerebrate_recall` / `cerebrate_remember` — 个人偏好读写
- `cerebrate_stats` — 虫群统计

## Model experience

- 每个工具执行一次 HTTP 请求，结果信封（v5 协议）以 JSON 文本返回给模型；网络失败返回结构化错误文本，不抛异常。
- 引导注入为 `plugin` 来源的 `instructions` 用户消息，写入 session 日志；已注入过的会话后续轮次不重复注入。

## Known Limitations and Deferred Work

- 未实现 MCP 桥的本地实体抽取（`auto_entities`）与交互式认证登录工具；token 通过环境变量或文件静态提供。
- 项目域（project_profile/navigate/harvest）、场景（scene_*）与技能版本（skill_*）工具未包含，需要时按同一模式扩展。
# @deepseek-ai/dsh-typesafe

TypeSafe System One（Jev）原生工具：把「可编程的常识」变成**代码可组合的判定原语**。

## 它解决什么问题

AI 写代码时经常需要**语义判断**才能分支，但语言里没有对应的原语，于是只有三条路：

1. 堆关键词 / 正则做启发式 —— **文案一改就静默失效**；
2. 让大模型「prompt 出一段文字再解析」—— 要一个结论却换来一段散文，还要自己写解析；
3. 把判断硬编码进业务流程 —— 策略一变就要改代码、重跑推理。

TypeSafe 把这类判断变成三种**类型化原语**，像函数一样被代码调用与组合：

| 原语 | 回答的问题 | 返回值 |
| --- | --- | --- |
| `choice` | 从定义好的集合里选一个 | 选中项 + 各选项概率（概率用于比较竞争选项） |
| `noul` | 某个条件是否成立 | 「是」的概率（0.5 附近 = 是非概率相近，**不是**程度中等） |
| `score` | 沿某个维度处于什么程度 | 概率加权的位置（同口径可排序） |

它**不生成文字、不给理由**，只给可以 `if` 的结论和概率 —— 流程、阈值、分支永远留在代码里。

## 工具

- `ts_judge` —— 把状态 + 问题交给 Jev，拿回可被代码直接消费的类型化判定（含真实模型版本与 token 用量）
- `ts_guide` —— 判定原语的使用哲学与设计要点（什么时候用、怎么设计问题、结果怎么消费）
- `ts_status` —— 密钥与连通性自检（把**配置问题**从**判定问题**里分离出来）

并在会话首步注入一次使用提醒（`injectGuidance`，可关）。

## 配置

```yaml
- insert:
    - id: dsh-typesafe
      name: '@deepseek-ai/dsh-typesafe'
      config:
        model: 'jev-latest'
        apiKeyEnv: 'TYPESAFE_API_KEY'
        apiKeyFile: '~/.credentials/typesafe-api-key'
        endpoint: 'https://api.typesafe.ai/v1/systemone'
        timeoutMs: 30000
        maxAttempts: 3
        injectGuidance: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `model` | `jev-latest` | 模型别名；服务端回包会给出真实版本号（如 `jev-1.13.0`） |
| `endpoint` | 官方地址 | 判定接口地址 |
| `apiKey` | 空 | 直接注入密钥（**不建议**，仓库/示例里一律不写真实值） |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | 环境变量名（优先于密钥文件） |
| `apiKeyFile` | `~/.credentials/typesafe-api-key` | 密钥文件（单一来源，权限 600） |
| `timeoutMs` | `30000` | 单次请求超时（毫秒） |
| `maxAttempts` | `3` | 最大尝试次数（仅对网络错误与 5xx/429 重试，4xx 不重试） |
| `injectGuidance` | `true` | 是否在会话首步注入一次使用提醒 |

密钥优先级：`apiKey` → `apiKeyEnv` → `apiKeyFile`。三处都没有时抛**可操作**的错误（附密钥获取地址）。
密钥只以「来源类别」出现在 `ts_status` 输出里，**绝不回显值**，也绝不写进返回结果。

## 用法

```jsonc
// ts_judge：一次问三道互不干扰的判断（并行执行，互不可见）
{
  "state": {
    "ticket": {
      "subject": "重复扣款",
      "messages": [{ "from": "customer", "text": "我的卡被扣了两次，请退款。" }]
    },
    "refund_policy": "重复扣款可退款。"
  },
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "哪个团队应当处理这封工单？",
      "criteria": { "billing": "账单或订阅问题", "technical": "缺陷或集成问题", "other": "其他" }
    },
    "is_urgent": { "type": "noul", "instructions": "这条消息表达了紧迫性吗？" },
    "frustration": {
      "type": "score",
      "instructions": "客户表现出的不满程度",
      "levels": ["平静陈述事实", "不满但克制", "非常愤怒"]
    }
  }
}
```

返回形状（`answers` 按问题 id 索引）：

```jsonc
{
  "ok": true,
  "summary": "department=technical(0.73) ｜ is_urgent=0.98 ｜ frustration=1(1.00) ｜ 模型=jev-1.13.0 ｜ in=392 out=65",
  "model": "jev-1.13.0",
  "answers": {
    "department": { "type": "choice", "choice": "technical", "confidence": 0.73, "probabilities": { "technical": 0.82, "billing": 0.18 } },
    "is_urgent": { "type": "noul", "noul": 0.98 },
    "frustration": { "type": "score", "score": 1, "confidence": 1.0, "legend": { "0": "平静陈述事实", "1": "不满但克制", "2": "非常愤怒" }, "probabilities": { "1": 1.0 } }
  },
  "usage": { "inputTokens": 392, "outputTokens": 65 }
}
```

## 设计要点（用之前值得知道的）

1. **问题 id 不会发给模型**。判断的全部含义必须写进 `instructions`；id 只给你 `if` 用。
2. **判断写进 `instructions`，答案定义写进 `criteria`**。`criteria` 每个值都要模型能独立读懂。
3. **模型选不出没给的候选**。做抽取/指定值时，候选必须由代码先枚举进 `criteria`。
4. **独立的问题一起问**（并行、互不可见），所以「如果有用」的推测性问题也可以一起发；
   只有需要前一个答案才能构造下一个状态时，才发第二次请求。
5. **阈值归代码，且在真实数据上调**。`confidence` 只表示分布集中度，**不表示流程正确**、不代表可以放行。
6. **失败要分辨来源**。本插件的错误按 `errorKind` 分类：
   `config`（密钥/配置）、`network`（网络/超时）、`api`（服务端返回错误，附 status）、`invalid`（入参或回包形状非法）；
   单测/语法错误/证据不足是另外的事，别混为一谈。

## 为什么零运行时依赖

官方 SKILL 把 HTTP API 作为首要路径，请求体形状简单稳定；本插件直接走 HTTP，
因此保持本仓「构建期内联、部署零 node_modules」的哲学，并少一层 SDK 版本漂移。
`fetch` 用 Node 18+ 内置实现，不需要任何第三方包。

## 目录结构

```
src/
  features/            # 砖块：原子、可复用、不含业务词汇
    primitives.ts      #   三种原语与结果的纯数据类型 + 错误类型
    questions.ts       #   choice/noul/score 构造与校验
    client.ts          #   密钥解析、HTTP 调用、重试、回包规范化
    guide.ts           #   给 AI 的使用指引文本
  business/
    tools.ts           # 编排：校验入参、调用砖块、整理返回、密钥诊断
  index.ts             # 装配：注册三个工具 + 会话首步指引
  invariant.ts         # 工具名不变量（供 host 装配校验）
tests/                 # 单测（全部离线，用 fetch 替身）
scripts/
  check-all.mjs        # 门禁：注释 → 类型 → 测试 → 构建 → 冒烟
  check-comments.mjs   # 注释语言检查（全中文）
  dev-smoke.mjs        # 冒烟：装配 + 注册 + 工具调用（离线，不需密钥）
  verify-live.ts       # 真实链路验证（需密钥与网络，显式运行）
```

## 验证

```bash
node scripts/check-all.mjs        # 门禁（离线，含冒烟）
node --import tsx scripts/verify-live.ts   # 真实链路验证（需密钥）
```

## 与经络 Meridian 的关系

`dsh-meridian` 的标尺用**日志标签子串**（`labelContains`）匹配意图；
真实语料实证：同一业务事实只要日志文案改写（含改成全英文），子串匹配就静默失配、
把真实偏离判成 `out-of-scope`（见 `dsh-meridian/docs/evidence-语义匹配器-文案脆弱性.md`）。

本插件是那类判断的通用底座：格式解析、事件 ID、顺序与耗时统计仍留在确定性代码里，
只有「这段日志属于哪个业务场景」「哪个事件体现了某一步骤」这类语义判断交给 `ts_judge`。

## 已知边界

- Jev 的主要训练语言是英文，中文等 CJK 文本可用但准确率较低（官方说明）；对中文语料的判定质量需在**你自己的数据上**评估。
- 单次调用量级（实测）：约 2–4 秒、输入约 600–700 tokens、输出约 60–70 tokens。
  应按「意图 × 案例」批处理，而不是逐事件调用。
- `criteria` 的值目前限制为非空字符串（官方亦支持对象/数组结构）。复杂的判据结构请写进 `instructions`。

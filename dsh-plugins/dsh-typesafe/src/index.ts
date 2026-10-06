/**
 * dsh-typesafe —— TypeSafe System One（Jev）原生工具。
 *
 * 三个工具：
 *   ts_judge  —— 把状态 + 问题交给 Jev，拿回**可被代码直接消费**的类型化判定
 *   ts_guide  —— 判定原语的使用哲学与设计要点（AI 第一读者）
 *   ts_status —— 密钥与连通性诊断（把配置问题从判定问题里分离出来）
 *
 * 定位：**TypeSafe 把「可编程的常识」做成编程原语**。它不是又一个「让大模型写字」的封装，
 * 而是把自然语言与状态变成 choice / noul / score 三种可 if 的结构化结论；
 * 流程、阈值、分支永远留在代码里（code owns the workflow）。
 *
 * 架构分层：本文件是装配层（仅注册工具 + 注入一次指引）；编排在 business/tools.ts；
 * 能力砖块在 features/（primitives 类型、questions 构造与校验、client HTTP、guide 文案）。
 * features/ 不含任何具体业务词汇，可被任意插件复用。
 *
 * 为什么零运行时依赖（明确取舍）：官方 SKILL 自己就把 HTTP API 作为首要路径，
 * 请求体形状简单稳定；直接走 HTTP 既保持本仓「构建期内联、部署零 node_modules」的哲学，
 * 也少一层版本漂移。因此这里不引入官方 JS SDK。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_ENDPOINT, DEFAULT_MODEL } from './features/client'
import { TypeSafeError } from './features/primitives'
import { TS_GUIDE } from './features/guide'
import {
  summarizeJudgement, tsJudge, tsStatus,
  type AnswerView, type JsonValue, type StatusReport, type ToolConfig,
} from './business/tools'

/** 插件标识与依赖注入。 */
export const name = 'dsh-typesafe'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-typesafe': { kind: 'dsh-typesafe'; form?: 'instructions' }
  }
}

/** 旧版 V3 会话消息迁移后的 kind；识别它以免升级后的会话重复注入。 */
const MIGRATED_PRODUCER_KIND = `plugin:${name}`
export const inject = ['tools']

/** 插件配置。 */
export interface TypeSafePluginConfig extends ToolConfig {
  /** 是否在会话首步注入一次使用指引。 */
  injectGuidance: boolean
}

/**
 * 配置 schema。
 *
 * 注意 apiKey 默认留空：仓库与配置示例里**一律不写真实密钥**，
 * 真实值走环境变量或 600 权限的密钥文件（单一来源）。
 */
export const Config: z<TypeSafePluginConfig> = z.object({
  model: z.string().default(DEFAULT_MODEL),
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().default('TYPESAFE_API_KEY'),
  apiKeyFile: z.string().default('~/.credentials/typesafe-api-key'),
  timeoutMs: z.number().default(30000),
  maxAttempts: z.number().default(3),
  injectGuidance: z.boolean().default(true),
})

/**
 * 把诊断报告转成工具返回值形状。
 *
 * 为什么要显式逐字段构造而不是直接 return 报告对象：工具的返回契约是 JsonValue，
 * 而接口类型没有索引签名；显式构造既满足契约，也让「哪些字段会返回给模型」一目了然
 * （比 as 断言更安全：新增字段时不会静默漏类型检查）。
 */
function toStatusValue(report: StatusReport): Record<string, JsonValue> {
  return {
    ok: report.ok,
    endpoint: report.endpoint,
    model: report.model,
    keySource: report.keySource,
    keySourceDetail: report.keySourceDetail,
    probe: report.probe,
    ...(report.servedModel === undefined ? {} : { servedModel: report.servedModel }),
    ...(report.usage === undefined ? {} : { usage: { inputTokens: report.usage.inputTokens, outputTokens: report.usage.outputTokens } }),
  }
}

/**
 * 把规范化答案转成工具返回值形状。
 *
 * 为什么不直接返回内部答案对象：内部形状含可选字段，展开进返回值会宽化成 unknown，
 * 破坏 JsonValue 契约。显式逐字段构造既满足契约，也让「模型能看到哪些字段」一目了然。
 */
function toAnswerViews(result: { answers: Record<string, AnswerView> }): Record<string, JsonValue> {
  const views: Record<string, JsonValue> = {}
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === 'choice') {
      views[id] = { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: { ...answer.probabilities } }
    } else if (answer.type === 'noul') {
      views[id] = { type: 'noul', noul: answer.noul }
    } else {
      views[id] = { type: 'score', score: answer.score, confidence: answer.confidence, legend: { ...answer.legend }, probabilities: { ...answer.probabilities } }
    }
  }
  return views
}

/** 工具返回渲染：统一输出格式化 JSON，便于 AI 与人工核对。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/**
 * 工具参数形态 —— 刻意按**未校验 JSON**声明（Record<string, unknown>）。
 *
 * 原因：工具参数来自模型生成的 JSON，属不可信边界输入；真正的类型在 business 层
 * 校验后才产生（与同仓 dsh-meridian 同一约定）。
 */
type RawArgs = Record<string, unknown>

/**
 * 把异常转成模型可读的结构化结果。
 *
 * 为什么不让异常继续上抛：工具失败应当**显式且可操作**。这里保留 kind 与 status，
 * 模型才能判断下一步是「改配置」「重试」还是「修问题」。
 */
function renderError(error: unknown): Record<string, JsonValue> {
  if (error instanceof TypeSafeError) {
    const payload: Record<string, JsonValue> = { ok: false, errorKind: error.kind, message: error.message }
    if (error.status !== undefined) payload.status = error.status
    return payload
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, errorKind: 'unknown', message }
}

/** 首步提醒文案：只讲「什么时候想起它」，详细方法交给 ts_guide（省 token）。 */
const INJECTION_GUIDANCE = [
  '【可编程常识 · TypeSafe】本会话具备 ts_judge：把自然语言与状态变成**类型化判定**（choice/noul/score），可直接被代码 if。',
  '· 什么时候用：需要一个**语义判断**才能分支/排序/抽取/校验时——分诊、路由、分类、判断严重度、判断两段文本是否同一意思。',
  '· 什么时候不用：纯计算、精确查找、格式解析仍应留在代码里；模型只提供常识，流程与阈值归代码（code owns the workflow）。',
  '· 别再拿关键词/正则堆启发式，也别「让大模型写段文字再解析」——要结构化结论就直接问结构化问题。',
  '· 独立的问题**一起问**（并行、互不可见）；阈值必须在真实数据上调，confidence 只表示分布集中度，不代表可以放行。',
  '· 用法细节见 ts_guide；先跑 ts_status 自检密钥与连通性。',
].join('\n')

/**
 * 插件装配：注册三个工具 + 首次会话注入一次使用指引。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置（密钥来源、模型与超时）。
 */
export function apply(ctx: Context, config: TypeSafePluginConfig): void {
  const toolConfig: ToolConfig = {
    ...(config.apiKey === undefined || config.apiKey === '' ? {} : { apiKey: config.apiKey }),
    ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
    ...(config.apiKeyFile === undefined ? {} : { apiKeyFile: config.apiKeyFile }),
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts }),
    // fetch 实现也随配置透传：冒烟与测试用它注入替身，
    // 否则会把「离线可跑的冒烟」变成真实网络调用（本仓门禁必须可离线执行）。
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  }

  ctx.tools.register(defineTool({
    name: 'ts_judge',
    description:
      '【结构化判定】把状态与问题交给 TypeSafe System One（Jev），拿回可被代码直接消费的类型化判定。三种原语：choice（从定义好的集合里选一个，附各选项概率，用于比较竞争选项）、noul（判断某个条件是否成立，只给「是」的概率，0.5 附近=是非概率相近而非程度中等）、score（沿某维度给有序程度，可用于排序）。要点：问题 id 不会发给模型，判断含义必须写进 instructions；模型选不出未列入 criteria 的候选；独立问题一起问。返回含实际模型版本与 token 用量。',
    parameters: {
      state: {
        // 官方契约：state 是 string | object | array。这里用 oneOf 精确表达该联合，
        // 让**模型**从 schema 就能看出三种合法形态；数字/布尔/null 被 schema 挡在外面。
        oneOf: [
          { type: 'string' as const },
          { type: 'object' as const, additionalProperties: true },
          { type: 'array' as const },
        ],
        description:
          '据以判断的状态，三种形态：①对象（最推荐，命名 JSON 字段，如 { ticket: { subject, messages }, policy }）；②字符串（一段纯文本）；③数组（消息/记录序列）。instructions 里可用反引号引用路径（如 ticket.messages 的写法）。状态给得越完整，判定越可靠。',
      },
      questions: {
        type: 'object' as const,
        additionalProperties: true,
        description:
          '问题表（问题 id → 问题声明）：{ type: "choice", instructions, criteria: {选项键: 语义说明} } / { type: "noul", instructions } / { type: "score", instructions, levels: ["低","中","高"] }。',
      },
      model: { type: 'string' as const, description: '覆盖默认模型别名（缺省 jev-latest；服务端回包会给出真实版本号）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: async (args: RawArgs): Promise<Record<string, JsonValue>> => {
      try {
        const result = await tsJudge(toolConfig, args)
        return {
          ok: true,
          summary: summarizeJudgement(result),
          model: result.model,
          answers: toAnswerViews(result),
          usage: result.usage === null ? null : { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        }
      } catch (error) {
        return renderError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ts_guide',
    description: '【判定原语指引】TypeSafe System One 的使用哲学：什么时候用、三种原语怎么选、怎么设计判断（instructions/criteria/state）、结果怎么消费（阈值归代码、confidence 不等于放行、失败要分辨来源）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: async () => ({ guide: TS_GUIDE, endpoint: DEFAULT_ENDPOINT, defaultModel: DEFAULT_MODEL }),
  }))

  ctx.tools.register(defineTool({
    name: 'ts_status',
    description: '【判定自检】诊断密钥与连通性：密钥来源类别（不回显密钥值）、endpoint、模型别名，并实际发一道答案确定的探测请求验证整条链路。配错密钥或网络不通时先跑它，把配置问题和判定问题分开。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: async (): Promise<Record<string, JsonValue>> => toStatusValue(await tsStatus(toolConfig)),
  }))

  // 会话首步注入一次使用指引（同一插件只注入一次，避免每步刷屏）
  if (config.injectGuidance !== false) {
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      const alreadyInjected = agent.session.surface.nodes.some((seq) => {
        const event = agent.session.eventAt(seq)
        if (event?.type !== 'user/message') return false
        const kind: string = event.data.source.kind
        return kind === name || kind === MIGRATED_PRODUCER_KIND
      })
      if (alreadyInjected) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text' as const, text: INJECTION_GUIDANCE }],
        source: { kind: name, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message))
      return { kind: 'enter' as const, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

/** 供程序化使用的再导出（能力砖块）。 */
export { TypeSafeClient, resolveApiKey, parseResponse, DEFAULT_ENDPOINT, DEFAULT_MODEL } from './features/client'
export { choice, noul, score, validateQuestion, validateQuestions } from './features/questions'
export { TypeSafeError } from './features/primitives'
export { TS_GUIDE } from './features/guide'
export { tsJudge, tsStatus, summarizeJudgement } from './business/tools'
export type { Answer, ChoiceCriteria, JudgementResult, PrimitiveKind, QuestionSpec, Usage } from './features/primitives'
export type { ClientOptions, FetchLike, JudgeInput, KeySources } from './features/client'
export type { StatusReport, ToolConfig } from './business/tools'

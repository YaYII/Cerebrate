/**
 * dsh-meridian（经络 Meridian）—— AI 的运行时态接口 + 自校验标尺。
 *
 * 四个工具：
 *   mer_facts    —— 把日志变成**有界、带证据、带覆盖度**的运行时事实（技术案例 / 业务对象两种视角）
 *   mer_verdict  —— 把「AI 声明的意图」与运行期事实对比，产出**可复核**的判定（五类偏离 + 证据）
 *   mer_baseline —— 行为指纹基线对比，区分「只是改名」与「行为真的变了」
 *   mer_guide    —— 产品哲学与用法（AI 第一读者）
 *
 * 定位（用户拍板）：**AI 是第一读者，人是第二读者**——人做决策，AI 做校验。
 * 产品回答的不是「系统现在健康吗」（那是 APM），而是
 * 「**我这段代码运行起来，是不是我想的那样**」。
 *
 * 架构分层：本文件是装配层（仅注册工具）；编排在 business/tools.ts；能力在 features/；
 * 被观测系统的接入声明在 packs/（是数据不是代码）。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { merBaseline, merFacts, merHotspots, merVerdict, parseIntents, parsePackDefinition } from './business/tools'
import type { RulePack } from './features/rulePack'

/** 插件标识与依赖注入。 */
export const name = 'dsh-meridian'
export const inject = ['tools']

/** 插件配置。 */
export interface MeridianConfig {
  /** 默认接入名（`dsedt` / `ihm2` / `python` / `json`）；缺省 `dsedt`。 */
  defaultPack: string
  /** 是否在会话首步注入一次使用指引（让 AI 自己想起来用运行期事实校验）。 */
  injectGuidance: boolean
}

/** 配置 schema：字段带默认值，未配置时也能装配。 */
export const Config: z<MeridianConfig> = z.object({
  defaultPack: z.string().default('dsedt'),
  injectGuidance: z.boolean().default(true),
})

/** 工具返回渲染：统一输出格式化 JSON，便于 AI 与人工核对。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 形态：接入声明参数（内置名或内联声明二选一）。 */
const packParameters = {
  pack: { type: 'string' as const, description: '内置接入名：dsedt（Java/logback）或 ihm2（PHP/Monolog）。缺省取插件默认。' },
  definition: {
    type: 'object' as const,
    additionalProperties: true,
    description:
      '内联接入声明（未内置的系统用）：{ name, formats:[{name,declaration}], rules:[{name,phase,pattern,...}] }。' +
      'declaration 支持 logback（%d{}/%msg）与 Monolog（%datetime%/%message%）两种写法。',
  },
}

/**
 * 工具入参形态 —— 刻意按**未校验 JSON** 声明（`Record<string, unknown>`），
 * 因为工具参数来自模型生成，属不可信边界输入；真正的类型在 business 层校验后产生。
 */
interface RawPackArgs {
  pack?: string
  definition?: Record<string, unknown>
}

/** 事实工具入参形态。 */
interface FactsArgsShape extends RawPackArgs {
  log?: string
  view?: string
  id?: string
  offset?: number
  limit?: number
}

/** 判定工具入参形态。 */
interface VerdictArgsShape extends RawPackArgs {
  log?: string
  intents?: Record<string, unknown>[]
  view?: string
}

/** 基线工具入参形态。 */
interface BaselineArgsShape extends RawPackArgs {
  log?: string
  baseline?: string
}

/** 热点工具入参形态。 */
interface HotspotsArgsShape extends RawPackArgs {
  log?: string
  top?: number
}

/** 断言必填参数存在；缺失时抛可读错误（而不是返回空结果）。 */
function requireArg(value: string | undefined, field: string): string {
  if (value === undefined || value === '') throw new Error(`缺少必填参数 ${field}`)
  return value
}

/** 组装接入参数（显式剔除 undefined，满足 exactOptionalPropertyTypes）。 */
function packArgs(
  args: RawPackArgs,
  defaultPack: string,
): { pack: string; definition?: RulePack } {
  return args.definition === undefined
    ? { pack: args.pack ?? defaultPack }
    : { pack: args.pack ?? defaultPack, definition: parsePackDefinition(args.definition) }
}

/** 产品哲学与用法指引（给 AI 看的第一读者说明书）。 */
const MER_GUIDANCE = `经络 Meridian 是「运行时态接口 + 自校验标尺」。使用要点：

1. **先看覆盖度，再看事实**。任何 mer_facts 返回都带 coverage 与 coverageNote；
   若 verdict=failed，说明**日志格式与声明漂移**，此时「0 条事实」不等于「系统没问题」——
   必须先修 declaration 再下结论。
2. **区分两种案例视角**：case（技术案例 = 一次请求，靠 traceId）与 object（业务对象 = 一张单据，靠单据号）。
   真实数据里二者常相差一个数量级；问「这张单据经历了什么」要用 view=object。
3. **判定前必须有意图**。意图 = 「我认为这段代码应该怎么运行」的显式断言（expect 步骤序列 + expectEnd），
   且应**按场景绑定**（appliesWhen），否则会把另一条合法分支误报成漏做。
4. **判定不可信时它会拒绝**：事实不可信 → status=inconclusive；场景不匹配 → out-of-scope。
   这两种都不是失败，而是标尺在保护自己的权威性。
5. **每一条结论都必须能回跳证据**（evidence 字段给出 来源:行号）。向用户汇报时请引用行号。
6. **被观测系统尚未内置时**：用 definition 传内联声明（一份格式 + 若干消息规则）即可接入，
   无需改被观测项目一行代码。`

/**
 * 注入给 AI 的一次性使用指引。
 *
 * 与 `mer_guide` 的分工：`mer_guide` 是「主动查询时的说明书」；
 * 本常量是「会话首步的提醒」——解决一个真实问题：
 * **能力存在 ≠ 会被使用**。AI 在惯性下会直接读代码推断行为，
 * 而不是去拿运行期事实；一次提醒足以把它拉回正确的工作方式。
 */
const MERIDIAN_GUIDANCE = [
  '【运行时态自校验 · 经络 Meridian】本会话可在**运行期事实**上校验改动，不必只靠读代码推断：',
  '· 改完代码后：跑一次（测试或服务）→ 用 mer_baseline 对比改动前后的日志。',
  '  它会区分 identical（行为没变）/ relabeled（只是改名，低置信）/ length-changed（多做或少做步骤，高置信）/',
  '  structure-changed（结构变化，高置信），并给出首个分歧位置与两侧证据行号。',
  '· 要判断「是否符合预期」：用 mer_verdict 声明期望步骤（expect + expectEnd + allow），',
  '  它按五类偏离给判定；事实不可信时它会拒绝判定（inconclusive），场景不匹配时跳过（out-of-scope）——这是保护，不是失败。',
  '· 要定位优化空间：用 mer_hotspots 看「时间花在哪、慢在哪一段」（含分段耗时与证据行号），而不是凭经验挑。',
  '· 任何事实结果都先看 coverageNote：verdict=failed 表示日志格式与接入声明已漂移，',
  '  此时「0 条事实」**不等于**「系统没问题」——必须先修 declaration 再下结论。',
].join('\n')

/**
 * 插件装配：注册五个工具 + 注入一次使用指引。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置（含默认接入名）。
 */
export function apply(ctx: Context, config: MeridianConfig): void {
  const defaultPack = config.defaultPack ?? 'dsedt'

  ctx.tools.register(defineTool({
    name: 'mer_facts',
    description:
      '【运行时事实】把日志文件变成有界、带证据、带覆盖度的运行时事实。三种视角：case（技术案例=一次请求）、object（业务对象=一张单据的一生）、coverage（只看解析覆盖度）。每条事实都带「来源:行号」可回跳。当覆盖度结论为 failed 时，明确表示事实不可信、不可作为「系统无问题」的依据。',
    parameters: {
      log: { type: 'string', description: '日志文件路径（必填）' },
      ...packParameters,
      view: { type: 'string', description: '视角：case（默认）/ object / coverage' },
      id: { type: 'string', description: '只看某个案例 ID 或业务对象 ID' },
      offset: { type: 'number', description: '分页起始（默认 0）' },
      limit: { type: 'number', description: '分页大小（默认 20，上限 200）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: async (args: FactsArgsShape) => {
      const view = args.view === 'object' || args.view === 'coverage' ? args.view : 'case'
      return merFacts({
        log: requireArg(args.log, 'log'),
        view,
        ...packArgs(args, defaultPack),
        ...(args.id === undefined ? {} : { id: args.id }),
        ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mer_verdict',
    description:
      '【意图判定】把「AI 声明的意图」与运行期事实对比，产出可被第二个 AI 只凭证据复核的判定。五类偏离：move-on-model（漏做环节）、move-on-log（越权/额外路径）、stuck（未达终态）、order-deviation（顺序偏离）、failed-step（该成功却失败）。事实不可信时拒绝判定（inconclusive），场景不匹配时跳过（out-of-scope）。',
    parameters: {
      log: { type: 'string', description: '日志文件路径（必填）' },
      ...packParameters,
      intents: {
        type: 'array' as const,
        items: { type: 'object' as const, additionalProperties: true },
        description:
          '意图声明数组（缺省用内置意图）：[{ name, appliesWhen?, expect:[{name,match:{labelContains?,phase?,level?},optional?,mustSucceed?}], expectEnd?, allow? }]',
      },
      view: { type: 'string' as const, description: '判定粒度：case（技术案例，默认）/ object（业务对象=一张单据）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: async (args: VerdictArgsShape) =>
      merVerdict({
        log: requireArg(args.log, 'log'),
        ...packArgs(args, defaultPack),
        ...(args.intents === undefined ? {} : { intents: parseIntents(args.intents) }),
        ...(args.view === 'object' ? { view: 'object' as const } : {}),
      }),
  }))

  ctx.tools.register(defineTool({
    name: 'mer_baseline',
    description:
      '【行为基线对比】用双层指纹比较两次运行：结构层（对改名不敏感）+ 标签层（对文案敏感）。回答「AI 改完代码后行为变了没有」，并明确区分 identical（没变）/ relabeled（只是改名，低置信）/ length-changed（多做或少做步骤，高置信）/ structure-changed（结构变化，高置信）。',
    parameters: {
      log: { type: 'string', description: '当前运行日志（必填）' },
      baseline: { type: 'string', description: '基线日志（上一次运行产物，必填）' },
      ...packParameters,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: async (args: BaselineArgsShape) =>
      merBaseline({
        log: requireArg(args.log, 'log'),
        baseline: requireArg(args.baseline, 'baseline'),
        ...packArgs(args, defaultPack),
      }),
  }))

  ctx.tools.register(defineTool({
    name: 'mer_hotspots',
    description:
      '【热点归因】把带耗时的运行时事实聚合成可定位的优化证据：按活动给出 count/total/p50/p95/max 与采样证据行号，并单独统计事件内的**分段耗时**（回答「慢在哪一段」）。用于第二战场：用聚合证据替代经验猜测。',
    parameters: {
      log: { type: 'string', description: '日志文件路径（必填）' },
      ...packParameters,
      top: { type: 'number', description: '每张榜的条数（默认 10，上限 50）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: async (args: HotspotsArgsShape) =>
      merHotspots({
        log: requireArg(args.log, 'log'),
        ...packArgs(args, defaultPack),
        ...(args.top === undefined ? {} : { top: args.top }),
      }),
  }))

  // 会话首步注入一次使用指引（同插件只注入一次，避免每步刷屏）
  if (config.injectGuidance !== false) {
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      const alreadyInjected = agent.session.surface.nodes.some((seq) => {
        const event = agent.session.eventAt(seq)
        return (
          event?.type === 'user/message' &&
          event.data.source.kind === 'plugin' &&
          event.data.source.plugin === name
        )
      })
      if (alreadyInjected) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text' as const, text: MERIDIAN_GUIDANCE }],
        source: { kind: 'plugin' as const, plugin: name, form: 'instructions' as const },
      })
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message))
      return { kind: 'enter' as const, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }

  ctx.tools.register(defineTool({
    name: 'mer_guide',
    description: '【经络指引】运行时态接口 + 自校验标尺的使用哲学：先看覆盖度、区分技术案例与业务对象、意图要按场景绑定、结论必带证据。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: async () => ({ guide: MER_GUIDANCE, builtinPacks: ['dsedt', 'ihm2'] }),
  }))
}

/** 供程序化使用的再导出（features 能力层）。 */
export { ingestLogText, NO_CASE } from './features/ingest'
export { buildFingerprint, compareFingerprints, normalizeLabel } from './features/fingerprint'
export { judgeCase, matches, describeMatcher } from './features/ruler'
export { compileLogFormat, parseLogLine, translateMonolog } from './features/logFormat'
export { isSecretKey, redactJsonText, redactLine, redactText } from './features/redact'
export { DSEDT_PACK } from './packs/dsedtJavaLogback'
export { IHM2_PACK } from './packs/ihm2Laravel'
export { DSEDT_INTENTS } from './packs/dsedtIntent'
export type { RulePack, MessageRule } from './features/rulePack'
export type { Intent, Verdict, Finding } from './features/ruler'
export type { RuntimeEvent, Coverage, CaseFacts } from './features/eventModel'
export type { IngestResult } from './features/ingest'

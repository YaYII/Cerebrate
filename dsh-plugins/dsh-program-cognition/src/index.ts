/**
 * dsh-program-cognition —— 认知可观测性插件（注册进 DSH 供 AI 自检与复盘）。
 *
 * 六个工具：
 *   cog_scan       —— 静态砖块/服务/工具分类（5 规则带证据）
 *   cog_instrument —— 日志埋点编排（dryRun 默认 + 备份回滚）
 *   cog_trace      —— 运行时行为时序链采集
 *   cog_graph      —— 认知图谱聚合（静态档案 + 行为记录 + 语义注解）
 *   cog_agent      —— Agent 行为分析（会话级 Tracing：工具调用/幽灵路径/失败根源）
 *   cog_guide      —— 认知可观测性哲学指引
 *
 * 双引擎：
 *   引擎 A（程序认知）：扫描/埋点/采集，观测用户项目代码；
 *   引擎 B（Agent 行为分析）：零侵入监听 DSH 原生事件（agent/* + session/event），
 *   聚合 AI 自身行为并落盘 agent-behaviors.ndjson。
 *   语义翻译复用宿主 llm 服务（ctx.get('llm')），无 llm 时降级模板拼接。
 *
 * 架构分层：本文件是装配层（工具注册 + 事件监听 + 引导注入）；行为在
 * business/（tools.ts 顶层 execute 编排）与 features/（纯能力砖块）。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { join, resolve } from 'node:path'
import {
  executeCogScan, executeCogInstrument, executeCogTrace, executeCogGraph,
  executeCogAgent, executeCogGuide, type CogToolConfig,
} from './business/tools'
import { AgentTraceBuffer, recordFromSessionEvent, type AgentBehaviorKind } from './features/agentTrace'
import { createTranslator } from './features/translate'

/** 插件标识与依赖注入。 */
export const name = 'dsh-program-cognition'
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 产物目录（相对被观测项目）。 */
  artifactsDir: string
  /** 是否注入认知可观测性指引到首个 step。 */
  injectGuidance: boolean
  /** 引擎 B：是否记录工具参数详情（决策 #6：默认 true，redact 兜底）。 */
  captureToolArgs: boolean
  /** 引擎 B：行为缓冲上限（每条会话）。 */
  bufferLimit: number
  /** 引擎 B：采样率 0-1。 */
  sampleRate: number
  /** 语义翻译：指定 provider（缺省宿主第一个）。 */
  translateProvider?: string
  /** 语义翻译：指定模型（缺省 provider 默认解析）。 */
  translateModel?: string
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  artifactsDir: z.string().default('.code-cognition'),
  injectGuidance: z.boolean().default(true),
  captureToolArgs: z.boolean().default(true),
  bufferLimit: z.number().default(2000),
  sampleRate: z.number().default(1),
  translateProvider: z.string(),
  translateModel: z.string(),
})

/** 认知可观测性指引（注入到首个 agent step）。 */
const COG_GUIDANCE = [
  '【认知可观测性】本会话具备 dsh-program-cognition 工具：',
  '- cog_scan：静态砖块/服务/工具分类（5 规则带证据），知道业务砖块在哪。',
  '- cog_instrument：自动生成日志埋点（dryRun 默认，可回滚），补齐缺失日志。',
  '- cog_trace：运行时采集行为时序链（入参/出参/耗时/状态变更），实测业务流转。',
  '- cog_graph：认知图谱（静态档案 + 行为记录 + 语义注解），看系统语义结构。',
  '- cog_agent：Agent 行为分析（工具调用/幽灵路径/失败根源），复盘 AI 自身行为。',
  '功能是砖块、业务是组合、行为有证据：排查先 cog_trace 实测流转，再动手改。',
].join('\n')

/** 把工具返回值以美化 JSON 呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/**
 * 装配插件：注册六个工具 + 引擎 B 事件监听 + 语义翻译注入。
 * @param ctx - 携带工具注册表的注册上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const toolConfig: CogToolConfig = { artifactsDir: config.artifactsDir }

  // 语义翻译：复用宿主 llm 服务（可选依赖，无 llm 时降级模板拼接）
  const llm = ctx.get('llm') as unknown as LlmRuntime | undefined
  if (llm !== undefined) {
    const translator = createTranslator(llm, {
      ...config.translateProvider === undefined ? {} : { provider: config.translateProvider },
      ...config.translateModel === undefined ? {} : { model: config.translateModel },
    })
    if (translator !== null) toolConfig.translate = translator
  }

  ctx.tools.register(defineTool({
    name: 'cog_scan',
    description: '【静态砖块扫描】扫描项目源码，按 5 规则（纯计算/无持久化/无全局副作用/业务语义/规模适中）分类函数为砖块/服务/工具，返回判定证据与疑似隐式砖块提示。回答「业务砖块在哪」。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string }) => executeCogScan(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'cog_instrument',
    description: '【日志埋点编排】自动生成日志埋点（入口/出口/状态变更三类）并注入源码。默认 dryRun 只出 diff 预览，dryRun=false 才写入（自动备份可回滚）。回答「哪里缺日志、埋点长什么样」。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
      scope: { type: 'string', description: '限定范围：auto 或 file:相对路径 或 function:文件:函数名' },
      dryRun: { type: 'boolean', description: '默认 true 只预览；false 真实写入（自动备份）' },
      revert: { type: 'string', description: '回滚：传 backupDir 路径恢复原始文件' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string; scope?: string; dryRun?: boolean; revert?: string }) => executeCogInstrument(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'cog_trace',
    description: '【行为时序链采集】运行项目业务入口，采集函数调用时序链（入参摘要/耗时/状态变更），回答「这次业务流转实际发生了什么、哪里耗时」。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
      entry: { type: 'string', description: '入口文件相对路径（缺省自动探测 src/index.ts 等）' },
      timeoutMs: { type: 'number', description: '运行超时（毫秒，默认 60000）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string; entry?: string; timeoutMs?: number }) => executeCogTrace(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'cog_graph',
    description: '【认知图谱查询】聚合静态砖块档案与行为记录为认知图谱（节点/边/分层/热点/未观测依赖），可选语义注解（复用宿主 LLM）。回答「系统当前的语义结构」。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
      focus: { type: 'string', description: '焦点节点 id（文件:函数名），缺省全图' },
      depth: { type: 'number', description: '焦点扩展深度（默认 2）' },
      semantic: { type: 'boolean', description: '是否生成语义注解（调用宿主 LLM，默认 false）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string; focus?: string; depth?: number; semantic?: boolean }) => executeCogGraph(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'cog_agent',
    description: '【Agent 行为分析】查询 AI 自身行为流（会话级 Tracing）：工具调用/幽灵路径/失败根源，按会话/turn/工具过滤，可选 AI 复盘。回答「这个 AI 会话实际怎么思考、怎么行动」。',
    parameters: {
      project: { type: 'string', description: '行为记录所在项目（缺省为当前目录）' },
      sessionId: { type: 'string', description: '会话 id 过滤' },
      turn: { type: 'number', description: 'turn 号过滤' },
      tool: { type: 'string', description: '工具名过滤' },
      failed: { type: 'boolean', description: '仅看异常/失败记录' },
      semantic: { type: 'boolean', description: '是否生成 AI 复盘（调用宿主 LLM，默认 false）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string; sessionId?: string; turn?: number; tool?: string; failed?: boolean; semantic?: boolean }) => executeCogAgent(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'cog_guide',
    description: '【认知可观测性指引】功能是砖块、业务是组合、行为有证据——三层心智与使用顺序。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: () => executeCogGuide(),
  }))

  // ── 引擎 B：Agent 行为分析（零侵入监听 DSH 原生事件）──
  const traceBuffer = new AgentTraceBuffer({
    captureToolArgs: config.captureToolArgs,
    bufferLimit: config.bufferLimit,
    sampleRate: config.sampleRate,
  })
  const traceDir = resolve(process.cwd(), config.artifactsDir)
  const traceFile = join(traceDir, 'agent-behaviors.ndjson')

  const recordAgent = (agent: Agent, rec: {
    turn: number
    step: number
    kind: AgentBehaviorKind
    summary: string
    failed: boolean
    ts?: number
  }): void => {
    traceBuffer.push({
      ...rec,
      sessionId: agent.id,
      key: `${agent.id}:${rec.turn}:${rec.step}`,
      ts: rec.ts ?? Date.now(),
    })
  }
  // 缓冲满时立即落盘
  const flushIfFull = (): void => {
    if (traceBuffer.length >= config.bufferLimit) traceBuffer.flush(traceFile)
  }

  ctx.on('agent/session-start', ({ agent, source }) => {
    recordAgent(agent, { turn: 0, step: 0, kind: 'lifecycle', summary: `会话开始: ${source}`, failed: false })
  })
  ctx.on('agent/status', ({ agent, status }) => {
    recordAgent(agent, { turn: 0, step: 0, kind: 'status', summary: `状态: ${status}`, failed: false })
  })
  ctx.on('agent/inbox/discarded', ({ agent }) => {
    recordAgent(agent, { turn: 0, step: 0, kind: 'inbox', summary: '消息被丢弃（幽灵路径）', failed: true })
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') {
      recordAgent(payload.agent, {
        turn: payload.turn, step: payload.step, kind: 'step-proposal',
        summary: `步骤 ${payload.step} 被否决（幽灵路径）`, failed: true,
      })
    } else {
      recordAgent(payload.agent, {
        turn: payload.turn, step: payload.step, kind: 'step-proposal',
        summary: `步骤 ${payload.step} 提议（${payload.messages.length} 条消息）`, failed: false,
      })
    }
    flushIfFull()
    return decision
  })
  ctx.on('agent/request-error', async (payload, next) => {
    recordAgent(payload.agent, {
      turn: payload.turn, step: payload.step, kind: 'request-error',
      summary: `模型请求失败: ${payload.failure.message ?? payload.failure.code ?? '未知错误'}`,
      failed: true,
    })
    return next()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    recordAgent(agent, { turn: 0, step: 0, kind: 'lifecycle', summary: '会话结束', failed: false })
    traceBuffer.flush(traceFile)
  })
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (recordFromSessionEvent(traceBuffer, session.id, event, config.captureToolArgs)) {
      flushIfFull()
    }
  })

  if (config.injectGuidance) {
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (messages.some(m => String(m.content).includes('认知可观测性'))) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text', text: COG_GUIDANCE }],
        source: { kind: 'plugin', plugin: 'dsh-program-cognition', form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

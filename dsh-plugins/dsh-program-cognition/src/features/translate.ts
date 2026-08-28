/**
 * 语义翻译器 —— 把行为时序链翻译为业务语言（M6，决策 #4）。
 *
 * 复用 DSH 宿主模型能力（ctx.llm，LlmRuntime），不额外配置 API key：
 * adapter 与密钥由宿主 credentials 系统管理，插件只做路由。
 * 翻译失败（无 provider / 调用异常）时由业务层降级为模板拼接。
 *
 * 调用链（实证 packages/llm/llm/src/index.ts）：
 *   llm.listProviders() → llm.prepareCall({provider, model}) → prepared.stream({messages})
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { TraceRecord } from './collector'
import type { AgentBehaviorRecord } from './agentTrace'

/** 翻译函数签名（由装配层注入业务层）。 */
export type TranslateFn = (prompt: string, signal?: AbortSignal) => Promise<string>

/** 翻译器选项。 */
export interface TranslatorOptions {
  /** 指定 provider（缺省用宿主注册的第一个）。 */
  provider?: string
  /** 指定模型（缺省用 provider 的默认解析）。 */
  model?: string
}

/**
 * 创建翻译函数（复用宿主 llm 服务）。
 * @param llm - 宿主 LlmRuntime 服务。
 * @param options - 翻译器选项。
 * @returns 翻译函数；无可用 provider 时返回 null（业务层降级模板拼接）。
 */
export function createTranslator(llm: LlmRuntime, options: TranslatorOptions = {}): TranslateFn | null {
  let providers: Array<{ id: string }> = []
  try { providers = llm.listProviders() } catch { return null }
  const providerId = options.provider ?? providers[0]?.id
  if (!providerId) return null
  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    // 模型缺省解析：优先配置，其次 provider 模型列表首个
    let model = options.model
    if (!model) {
      try {
        const models = await llm.listModels(providerId)
        model = models[0]?.id
      } catch { model = undefined }
    }
    if (!model) throw new Error('模型解析失败')
    const prepared = await llm.prepareCall({ provider: providerId, model }, signal)
    const request: GenerateOptions = {
      provider: providerId,
      model: prepared.config.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-program-cognition', form: 'instructions' },
      })],
      ...signal === undefined ? {} : { signal },
    }
    let text = ''
    for await (const chunk of prepared.stream(request)) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    return text
  }
}

/**
 * 生成引擎 A 的翻译提示词（时序链 → 业务流转描述）。
 * @param records - 行为记录。
 * @param projectName - 项目名（用于提示词上下文）。
 * @returns 提示词文本。
 */
export function traceTranslatePrompt(records: TraceRecord[], projectName: string): string {
  const lines = records.slice(0, 200).map(r => {
    const parts = [`[${r.phase}]`, r.id]
    if (r.args) parts.push(`入参(${r.args})`)
    if (r.ms !== undefined) parts.push(`${r.ms}ms`)
    if (r.target) parts.push(`副作用:${r.target}`)
    return parts.join(' ')
  })
  return [
    `请把以下「${projectName}」项目的函数调用行为时序翻译成一段业务流转描述（中文，3-5 句），`,
    '解释这段流程在业务上做了什么、哪里值得注意（异常/耗时/状态变更）。',
    '只输出描述本身，不要输出分析过程。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * 生成引擎 B 的翻译提示词（Agent 行为流 → 行动复盘）。
 * @param records - Agent 行为记录。
 * @returns 提示词文本。
 */
export function agentTranslatePrompt(records: AgentBehaviorRecord[]): string {
  const lines = records.slice(-120).map(r => {
    const parts = [`t${r.turn}s${r.step}`, `[${r.kind}]`, r.summary]
    if (r.durationMs !== undefined) parts.push(`${r.durationMs}ms`)
    if (r.failed) parts.push('⚠️异常')
    return parts.join(' ')
  })
  return [
    '请把以下 AI 智能体的会话行为流翻译成一段行动复盘（中文，3-5 句）：',
    '这个 AI 在任务中做了什么决策、调用了哪些工具、遇到了什么问题、最终完成情况如何。',
    '只输出复盘本身，不要输出分析过程。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * 模板拼接翻译（降级方案，零依赖）：从记录中提取函数名与摘要拼成描述。
 * @param records - 行为记录（引擎 A 或引擎 B 通用）。
 * @param kind - 记录类型（trace / agent）。
 * @returns 描述文本。
 */
export function templateTranslate(records: Array<TraceRecord | AgentBehaviorRecord>, kind: 'trace' | 'agent'): string {
  if (records.length === 0) return '暂无行为数据（可先运行 cog_trace 采集程序行为，或等待引擎 B 记录 Agent 行为）。'
  if (kind === 'trace') {
    const trace = records as TraceRecord[]
    const calls = trace.filter(r => r.phase === 'entry')
    const states = trace.filter(r => r.phase === 'state-change')
    const lines: string[] = []
    lines.push(`本次执行共触发 ${calls.length} 个函数入口、${states.length} 处状态变更。`)
    lines.push(`主要流转：${calls.slice(0, 8).map(c => c.id.split(':').pop()).join(' → ')}。`)
    if (states.length > 0) lines.push(`状态变更点：${states.map(s => s.target).join('、')}。`)
    return lines.join('\n')
  }
  const ag = records as AgentBehaviorRecord[]
  const tools = ag.filter(r => r.kind === 'tool-call').map(r => r.toolName)
  const failed = ag.filter(r => r.failed)
  const lines: string[] = []
  lines.push(`本次会话共 ${new Set(ag.map(r => r.turn)).size} 个 turn、${tools.length} 次工具调用${failed.length > 0 ? `、${failed.length} 次异常` : ''}。`)
  if (tools.length > 0) lines.push(`使用工具：${[...new Set(tools)].join('、')}。`)
  if (failed.length > 0) lines.push(`异常摘要：${failed.slice(0, 3).map(f => f.summary).join('；')}。`)
  return lines.join('\n')
}

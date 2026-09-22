/**
 * 工具编排层 —— 把判定客户端包装成 AI 可直接调用的能力。
 *
 * 本文件干什么：校验不可信入参、调用 features 层、整理返回；并提供「密钥与连通性诊断」，
 *   让配置问题与判定问题能被分开定位。
 * 本文件不干什么：不做 HTTP（在 features/client）、不构造问题（在 features/questions）。
 *
 * 三条不可协商的返回约束：
 * 1. **密钥绝不出现在任何返回值里**（只报告来源类别与路径，不报告值）；
 * 2. **失败必须显式**：配置缺失 / 网络失败 / 回包异常分别给出不同的可操作 message，
 *    绝不把失败包装成「0 个答案」让模型误以为「没有问题」；
 * 3. **模型版本与用量必披露**：判定是要花钱的，真实模型版本与 token 成本必须可见。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, resolveApiKey, TypeSafeClient, type ClientOptions, type FetchLike } from '../features/client'
import { TypeSafeError, type Answer, type JudgementResult } from '../features/primitives'
import { validateQuestions } from '../features/questions'

/**
 * 一个最小的 JSON 值契约（与 DSH 工具返回契约同形）。
 *
 * 为什么在本层自带一份而不从 @deepseek-ai/dsh-util-values 引入：
 * 那会为一个类型引入一条运行时依赖；本插件刻意保持零依赖，
 * 而这份递归定义足够表达工具返回值（对象/数组/字符串/数字/布尔/null）。
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 工具层对外暴露的答案别名（装配层据此构造 JSON 安全形状）。 */
export type AnswerView = Answer

/** 工具层所需的插件配置（由装配层传入）。 */
export interface ToolConfig extends ClientOptions {
  /** 密钥文件默认路径（配置未给时使用）。 */
  defaultKeyFile?: string
}

/** 默认密钥文件路径：单一来源，权限 600。 */
export function defaultKeyFilePath(): string {
  return join(homedir(), '.credentials', 'typesafe-api-key')
}

/**
 * 判定工具：把状态与问题交给 System One，返回可被代码直接消费的答案。
 *
 * @param config - 插件配置（含密钥来源与模型）。
 * @param args - 工具入参（**不可信**：来自模型生成的 JSON）。
 * @returns 判定结果（含模型版本与用量）。
 * @throws TypeSafeError 当入参非法、密钥缺失、网络失败或回包异常时抛出。
 */
export async function tsJudge(config: ToolConfig, args: Record<string, unknown>): Promise<JudgementResult> {
  if (args.state === undefined) {
    throw new TypeSafeError('invalid', '缺少必填参数 state：判定必须要有据以判断的状态（字符串、对象或数组）')
  }
  /**
   * state 形态校验（官方契约：string | object | array）。
   *
   * 为什么要拦数字/布尔/null：它们在 JSON 里合法，但在 System One 里没有可判断的内容；
   * 放过去只会换来一个语义空洞的判定结果——宁可现在就告诉调用方 state 给错了。
   */
  if (typeof args.state === 'number' || typeof args.state === 'boolean' || args.state === null) {
    throw new TypeSafeError('invalid', 'state 必须是字符串、对象或数组（数组适合消息/记录序列）；数字、布尔与 null 无法作为判断依据')
  }
  const questions = validateQuestions(args.questions)
  const client = new TypeSafeClient(config)
  const model = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined
  return client.judge(model === undefined ? { state: args.state, questions } : { state: args.state, questions, model })
}

/** 诊断结果（供 ts_status 返回；密钥只以「来源类别」形式出现）。 */
export interface StatusReport {
  /** 是否一切就绪（密钥可解析且模型可答）。 */
  ok: boolean
  /** endpoint。 */
  endpoint: string
  /** 请求用的模型别名。 */
  model: string
  /** 密钥来源类别（绝不返回密钥本身）。 */
  keySource: 'config' | 'env' | 'file' | 'missing'
  /** 密钥来源细节（环境变量名或文件路径；不含密钥值）。 */
  keySourceDetail: string
  /** 连通性探测结论。 */
  probe: string
  /** 实际服务的模型版本（探测成功时给出）。 */
  servedModel?: string
  /** 探测用量（探测成功时给出）。 */
  usage?: { inputTokens: number; outputTokens: number }
}

/** 判定密钥来源类别（只看来源，不读也不用其值）。 */
function classifyKeySource(config: ToolConfig): { source: StatusReport['keySource']; detail: string } {
  if (typeof config.apiKey === 'string' && config.apiKey.trim() !== '') {
    return { source: 'config', detail: '插件配置 apiKey' }
  }
  const envName = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.trim() !== '' ? config.apiKeyEnv.trim() : 'TYPESAFE_API_KEY'
  const envValue = process.env[envName]
  if (typeof envValue === 'string' && envValue.trim() !== '') return { source: 'env', detail: '环境变量 ' + envName }
  const filePath = typeof config.apiKeyFile === 'string' && config.apiKeyFile.trim() !== '' ? config.apiKeyFile : (config.defaultKeyFile ?? defaultKeyFilePath())
  return { source: 'file', detail: '密钥文件 ' + filePath }
}

/**
 * 诊断工具：回答「密钥配好了吗、模型答得通吗」，把配置问题从判定问题里分离出来。
 *
 * 探测方式：发一道**答案确定**的 Noul 问题（状态固定为 ping），
 * 因此探测本身既验证了密钥/网络/回包整条链路，又不会因语义歧义给出误导结论。
 *
 * @param config - 插件配置。
 * @returns 诊断报告（失败时 ok=false 且 probe 说明原因，不抛异常）。
 */
export async function tsStatus(config: ToolConfig): Promise<StatusReport> {
  const client = new TypeSafeClient(config)
  const { source, detail } = classifyKeySource(config)
  const base: StatusReport = {
    ok: false,
    endpoint: client.endpoint,
    model: client.model,
    keySource: source,
    keySourceDetail: detail,
    probe: '未探测',
  }
  try {
    resolveApiKey(config)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...base, keySource: 'missing', probe: '密钥不可用：' + reason }
  }
  try {
    const result = await client.judge({
      state: 'ping',
      questions: { reachable: { type: 'noul', instructions: 'Is the text passed to you exactly the word "ping"?' } },
    })
    const answer = result.answers.reachable
    const probe = answer !== undefined && answer.type === 'noul' ? '模型可达（探测 noul=' + answer.noul.toFixed(2) + '）' : '模型可达（回包未含预期答案）'
    return {
      ...base,
      ok: true,
      probe,
      servedModel: result.model,
      ...(result.usage === null ? {} : { usage: result.usage }),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...base, probe: '探测失败：' + reason }
  }
}

/** 把单条答案压成可读文本。 */
function describeAnswer(answer: Answer): string {
  if (answer.type === 'noul') return answer.noul.toFixed(2)
  if (answer.type === 'choice') return answer.choice + '(' + answer.confidence.toFixed(2) + ')'
  return String(answer.score) + '(' + answer.confidence.toFixed(2) + ')'
}

/** 把判定结果压成单行摘要（给 AI 快速扫读；完整结构化结果仍在 answers 里）。 */
export function summarizeJudgement(result: JudgementResult): string {
  const parts: string[] = []
  for (const [id, answer] of Object.entries(result.answers)) {
    parts.push(id + '=' + describeAnswer(answer))
  }
  const usage = result.usage === null ? '用量未知' : 'in=' + result.usage.inputTokens + ' out=' + result.usage.outputTokens
  return parts.join(' ｜ ') + ' ｜ 模型=' + result.model + ' ｜ ' + usage
}

/** 暴露默认值，供装配层与指引文案保持一致（避免两处各写一份）。 */
export const DEFAULTS = { endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL } as const

/** 供装配层复用的 fetch 类型（测试替身用）。 */
export type { FetchLike }

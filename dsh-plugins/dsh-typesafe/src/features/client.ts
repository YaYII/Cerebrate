/**
 * TypeSafe HTTP 客户端砖块 —— 一次调用，一次结构化判定。
 *
 * 本文件干什么：解析密钥、发送 systemone 请求、重试瞬时失败、把回包规范化成可消费的 Answer。
 * 本文件不干什么：不构造问题（那在 questions）、不做工具编排（那在 business/tools）、不认识业务。
 *
 * 为什么直接走 HTTP 而不用官方 SDK（明确的工程取舍，非偷懒）：
 * 1. 官方 SKILL 自己就给出 HTTP API 作为首要路径，请求体形状简单且稳定；
 * 2. 本仓插件的哲学是「构建期内联、部署零运行时 node_modules」——引 SDK 会破坏它；
 * 3. 少一层依赖就少一次版本漂移，本插件对模型别名的处理也更直白。
 *
 * 安全约束（来自 SKILL）：密钥只允许存在于服务端/进程环境，**绝不随返回值外泄**，
 * 也绝不写进日志或工具输出。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { TypeSafeError, type Answer, type JudgementResult, type QuestionSpec, type Usage } from './primitives'

/** 默认 endpoint（官方 API 参考给出的地址）。 */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** 默认模型别名（官方 quickstart 使用 jev-latest，服务端回包会给出真实版本）。 */
export const DEFAULT_MODEL = 'jev-latest'

/** 密钥解析来源（按优先级依次尝试：显式配置 → 环境变量 → 密钥文件）。 */
export interface KeySources {
  /** 配置文件里直接写的密钥（不推荐，仅兼容部署侧注入）。 */
  apiKey?: string
  /** 环境变量名。 */
  apiKeyEnv?: string
  /** 密钥文件路径（支持 ~ 展开）。 */
  apiKeyFile?: string
}

/** 客户端可调参数。 */
export interface ClientOptions extends KeySources {
  /** endpoint（默认官方地址）。 */
  endpoint?: string
  /** 默认模型别名。 */
  model?: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number
  /** 最大尝试次数（含首次；仅对网络错误与 5xx/429 重试）。 */
  maxAttempts?: number
  /** 注入的 fetch 实现（测试用；缺省用全局 fetch）。 */
  fetchImpl?: FetchLike
}

/**
 * 最小 fetch 契约。
 *
 * 之所以自己声明而不用 typeof fetch：测试替身只需实现这两个字段，
 * 否则为了通过类型检查要伪造一堆用不到的属性，反而让测试变脆。
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

/** 展开 ~ 前缀并返回绝对路径。 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : join(process.cwd(), path)
}

/** 判定一个值是否为可用的非空字符串（用于密钥解析）。 */
function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 解析 API 密钥。
 *
 * 按 显式配置 → 环境变量 → 密钥文件 的顺序取值，全部落空时抛出**可操作**的错误：
 * 错误信息要明确告诉模型/用户密钥该放哪里，而不是只说「未配置」。
 *
 * @param sources - 密钥来源集合。
 * @returns 解析到的密钥。
 * @throws TypeSafeError（kind=config）当三处都取不到密钥时抛出。
 */
export function resolveApiKey(sources: KeySources): string {
  const direct = nonEmpty(sources.apiKey)
  if (direct !== null) return direct

  const envName = nonEmpty(sources.apiKeyEnv) ?? 'TYPESAFE_API_KEY'
  const fromEnv = nonEmpty(process.env[envName])
  if (fromEnv !== null) return fromEnv

  const filePath = nonEmpty(sources.apiKeyFile)
  if (filePath !== null) {
    const absolute = expandHome(filePath)
    /**
     * 关键区分：**文件不存在**说明「这条来源没配」，应继续走「三处都没有」的兜底错误；
     * 而**读取失败**（权限、目录等）说明「配了但用不了」，必须单独报出来。
     * 二者混为一谈会让最常见的首次配置场景拿到一个「读取失败」的误导性提示。
     */
    if (existsSync(absolute)) {
      const text = nonEmpty(readFileSync(absolute, 'utf8'))
      if (text === null) throw new TypeSafeError('config', '密钥文件为空：' + filePath)
      return text
    }
  }

  const hint = filePath === null ? '' : '，或写入密钥文件 ' + filePath
  throw new TypeSafeError(
    'config',
    '缺少 TypeSafe 密钥：请设置环境变量 ' + envName + hint + '。密钥获取：https://console.typesafe.ai/keys',
  )
}

/** 从任意 JSON 值里读数字，非有限数返回 null。 */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 从任意 JSON 值里读字符串→数字映射（丢弃非数字项）。 */
function readNumberMap(value: unknown): Record<string, number> {
  const result: Record<string, number> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const num = readNumber(item)
    if (num !== null) result[key] = num
  }
  return result
}

/** 从任意 JSON 值里读字符串→字符串映射（丢弃非字符串项）。 */
function readStringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

/**
 * 规范化单条答案。
 *
 * 为什么必须显式校验而不是直接 cast：回包跨越了**进程边界**，属不可信输入；
 * 直接断言类型会把错误推迟到业务分支里，产生难以定位的错误行为。
 * 返回 null 表示这条答案形状不认识，调用方决定如何处理。
 */
function normalizeAnswer(raw: unknown): Answer | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const type = obj.type

  if (type === 'choice') {
    const chosen = obj.choice
    if (typeof chosen !== 'string') return null
    return {
      type: 'choice',
      choice: chosen,
      confidence: readNumber(obj.confidence) ?? 0,
      probabilities: readNumberMap(obj.probabilities),
    }
  }

  if (type === 'noul') {
    const noulValue = readNumber(obj.noul)
    if (noulValue === null) return null
    return { type: 'noul', noul: noulValue }
  }

  if (type === 'score') {
    const scoreValue = readNumber(obj.score)
    if (scoreValue === null) return null
    return {
      type: 'score',
      score: scoreValue,
      confidence: readNumber(obj.confidence) ?? 0,
      legend: readStringMap(obj.legend),
      probabilities: readNumberMap(obj.probabilities),
    }
  }

  return null
}

/** 解析 usage（缺字段时返回 null，而不是伪造 0——伪造会让成本核算失真）。 */
function normalizeUsage(raw: unknown): Usage | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const input = readNumber(obj.input_tokens)
  const output = readNumber(obj.output_tokens)
  if (input === null && output === null) return null
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 }
}

/** 判断 HTTP 状态码是否值得重试（限流与服务端错误可重试，客户端错误不可）。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** 休眠指定毫秒（重试退避用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 一次判定的入参。 */
export interface JudgeInput {
  /** 交给模型的状态：字符串，或含命名 JSON 字段的对象/数组（推荐后者）。 */
  state: unknown
  /** 问题表（问题 id → 问题声明）。 */
  questions: Record<string, QuestionSpec>
  /** 覆盖默认模型别名。 */
  model?: string
}

/**
 * TypeSafe 判定客户端。
 *
 * 生命周期：构造即完成配置解析（密钥延迟到首次请求才读取，避免只是装配插件就因缺密钥而失败）。
 */
export class TypeSafeClient {
  private readonly options: ClientOptions
  private readonly fetcher: FetchLike

  constructor(options: ClientOptions = {}) {
    this.options = options
    this.fetcher = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    if (typeof this.fetcher !== 'function') {
      throw new TypeSafeError('config', '当前 Node 运行时没有可用的 fetch：请使用 Node 18+，或在配置里注入 fetchImpl')
    }
  }

  /** 请求用的 endpoint。 */
  get endpoint(): string {
    return nonEmpty(this.options.endpoint) ?? DEFAULT_ENDPOINT
  }

  /** 默认模型别名。 */
  get model(): string {
    return nonEmpty(this.options.model) ?? DEFAULT_MODEL
  }

  /**
   * 发送一次判定请求（含重试与超时）。
   *
   * 其中 state 与 questions 的语义约束由 TypeSafe 服务端与官方文档定义，
   * 本方法只保证：请求可传、失败可读、回包已校验。
   *
   * @param input - 状态 + 问题表（+ 可选模型覆盖）。
   * @returns 规范化后的判定结果。
   * @throws TypeSafeError（config/network/api/invalid）分别对应不同失败面。
   */
  async judge(input: JudgeInput): Promise<JudgementResult> {
    const apiKey = resolveApiKey(this.options)
    const model = nonEmpty(input.model) ?? this.model
    const timeoutMs = this.options.timeoutMs ?? 30000
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? 3)
    const body = JSON.stringify({ state: input.state, model, questions: input.questions })

    let lastError: TypeSafeError | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })
        const text = await response.text()
        if (!response.ok) {
          const error = new TypeSafeError('api', 'TypeSafe 返回 HTTP ' + response.status + '：' + text.slice(0, 300), response.status)
          if (!isRetryableStatus(response.status)) throw error
          lastError = error
        } else {
          return parseResponse(text, model)
        }
      } catch (error) {
        if (error instanceof TypeSafeError && !isRetryableStatus(error.status ?? 0)) throw error
        if (error instanceof TypeSafeError) {
          lastError = error
        } else {
          const reason = error instanceof Error ? error.message : String(error)
          lastError = new TypeSafeError('network', 'TypeSafe 请求失败：' + reason)
        }
      } finally {
        clearTimeout(timer)
      }
      if (attempt < maxAttempts) await sleep(200 * attempt)
    }
    throw lastError ?? new TypeSafeError('network', 'TypeSafe 请求失败：已达最大尝试次数 ' + maxAttempts)
  }
}

/**
 * 解析非 2xx 之外的成功回包。
 *
 * @param text - 原始响应文本。
 * @param requestedModel - 请求时使用的模型别名（回包缺 model 字段时兜底）。
 * @returns 规范化后的判定结果。
 * @throws TypeSafeError（kind=invalid）当回包不是合法 JSON 时抛出。
 */
export function parseResponse(text: string, requestedModel: string): JudgementResult {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new TypeSafeError('invalid', 'TypeSafe 回包不是合法 JSON：' + text.slice(0, 200))
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeSafeError('invalid', 'TypeSafe 回包不是对象')
  }
  const obj = payload as Record<string, unknown>
  const rawAnswers = obj.answers
  const answers: Record<string, Answer> = {}
  if (rawAnswers !== null && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
    for (const [id, raw] of Object.entries(rawAnswers as Record<string, unknown>)) {
      const answer = normalizeAnswer(raw)
      if (answer !== null) answers[id] = answer
    }
  }
  return {
    model: typeof obj.model === 'string' ? obj.model : requestedModel,
    answers,
    usage: normalizeUsage(obj.usage),
  }
}

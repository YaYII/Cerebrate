/**
 * 判定原语类型砖块 —— Choice / Noul / Score 三种问题的数据形状与判定结果形状。
 *
 * 本文件干什么：定义可被代码消费的**纯数据类型**（问题声明 + 判定结果），以及结果校验错误。
 * 本文件不干什么：不发请求（那在 client）、不构造问题（那在 questions）、不认识任何具体业务。
 *
 * 设计依据（来自 TypeSafe 官方 SKILL 与文档，非猜测）：
 * - **code owns the workflow**：模型只提供可编程的常识，流程与阈值永远归代码；
 * - 问题 id 只给代码用，**不会发给模型**，所以语义必须写进 instructions/criteria；
 * - Choice 的 probabilities 用于**比较竞争选项**；Score 同样可作可比评分用于排序；
 * - Noul 只给「是」的概率，没有单独 confidence，因此一个标签一个 Noul。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

/** 判定原语种类。 */
export type PrimitiveKind = 'choice' | 'noul' | 'score'

/**
 * Choice 判据：从**定义好的集合**里选一个。
 *
 * 键是判据标识（代码用它分支），值是给模型读的**语义说明**——必须写成模型能独立理解的含义，
 * 因为键本身不会发给模型。
 */
export type ChoiceCriteria = Record<string, string>

/**
 * 发给模型的问题声明（三种原语共用同一信封，只用 type 区分）。
 *
 * instructions 与 criteria 允许传结构化对象/数组（官方 advanced: structure 特性），
 * 用于在定义、对比、排除、示例能澄清语义时把话说清楚——这也是本类型用 unknown 的原因：
 * 结构由调用方按语义决定，插件不越权替调用方收窄。
 */
export interface QuestionSpec {
  /** 原语种类。 */
  type: PrimitiveKind
  /** 这道判断在问什么（**必须自洽**：模型看不到问题 id）。 */
  instructions: unknown
  /** choice 的选项定义。 */
  criteria?: ChoiceCriteria
  /** score 的有序等级（从低到高）。 */
  levels?: string[]
}

/** 一条判定结果（三选一，取决于问题类型）。 */
export type Answer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> }

/** 一次调用的用量（用于成本核算）。 */
export interface Usage {
  inputTokens: number
  outputTokens: number
}

/** 一次判定的完整结果。 */
export interface JudgementResult {
  /** 实际服务的模型版本（由服务端回包给出，可能与请求别名不同）。 */
  model: string
  /** 按问题 id 索引的判定结果。 */
  answers: Record<string, Answer>
  usage: Usage | null
}

/**
 * 插件自身的错误类型。
 *
 * 为什么要显式区分：把「配置缺失」「网络失败」「模型返回不可解析」三类问题
 * 用不同 message 暴露给模型，模型才能做出正确的下一步（改配置 / 重试 / 修问题）。
 */
export class TypeSafeError extends Error {
  /** 失败类别。 */
  readonly kind: 'config' | 'network' | 'api' | 'invalid'
  /** HTTP 状态码（若有）。 */
  readonly status?: number

  constructor(kind: 'config' | 'network' | 'api' | 'invalid', message: string, status?: number) {
    super(message)
    this.name = 'TypeSafeError'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

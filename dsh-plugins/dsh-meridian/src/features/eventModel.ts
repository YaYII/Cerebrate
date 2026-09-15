/**
 * 运行时事件模型砖块 —— 语言中立的「程序运行期事实」数据结构与证据绑定规则。
 *
 * 本文件干什么：定义事件、证据、案例、覆盖度四类纯数据类型，以及稳定事件 ID 的生成规则。
 * 本文件不干什么：不解析日志、不读文件、不认识任何具体语言或框架。
 *
 * 两条不可协商的约束（来自产品第一性原则）：
 * 1. 每个事实必须携带**可回跳的证据**（来源 + 行号 + 原文片段），否则不得进入模型；
 * 2. 事件 ID 必须**与文案解耦**（只用来源与行号生成），否则改一句日志文案就会让基线漂移。
 *
 * @module @deepseek-ai/dsh-meridian
 */

/** 事件的语义相位。`step` 表示方法内部的业务步骤，粒度细于调用边界。 */
export type EventPhase =
  | 'request-in'
  | 'request-out'
  | 'body'
  | 'call'
  | 'return'
  | 'exception'
  | 'step'
  | 'step-end'
  | 'audit'
  /** 性能异常事实（如慢查询）：属第二战场（线上排查）的证据来源。 */
  | 'slow'
  | 'log'

/** 证据锚点：任何事实都必须能凭它回跳到原始日志。 */
export interface Evidence {
  /** 证据来源（日志文件路径或逻辑来源名）。 */
  source: string
  /** 起始行号（1 基）。 */
  line: number
  /** 涉及的行数（续行/堆栈时为多行）。 */
  lineCount: number
  /** 原文片段（截断后），用于人工与 AI 快速核对。 */
  snippet: string
}

/** 单条运行时事件。 */
export interface RuntimeEvent {
  /** 稳定事件 ID：`来源#起始行`，与日志文案无关。 */
  id: string
  /** 在案例内的顺序号（1 基）。 */
  seq: number
  /** 时间片段（按声明格式截取）。 */
  ts: string
  /** 日志级别。 */
  level: string
  /** 日志记录器名（通常为类全名）。 */
  logger: string
  /** 线程名。 */
  thread: string
  /** 案例标识（如 traceId）；缺失时为空串，由上层决定是否可用。 */
  caseId: string
  /**
   * 业务对象标识（如单据号 app_no）；缺失时为空串。
   *
   * **它与 caseId 的区别是本产品的核心概念之一**：caseId 是技术案例（一次请求），
   * objectId 才是业务案例（一张单据）。两者是**多对多**关系——
   * 一张单据可能跨多次请求，一次请求也可能碰多张单据。
   * 真实语料实证：IHM2 的同一条业务日志里同时有 `trace_id` 与 `app_no`。
   */
  objectId: string
  /**
   * 该事件的业务对象标识是否**被掩码截断**（如应用自身脱敏后的 `ORD-9006aa…（已脱敏）`）。
   *
   * 为什么要标记而不是丢弃：截断后的值仍是"同一张单据的线索"，可归一化后归组；
   * 但它**不是可靠身份**——若两个单据号共享同一前缀，就会被错误合并。
   * 因此归一化的同时必须把这件事**披露出来**，让人/AI 知道该案例的归组可能不精确。
   */
  objectIdMasked: boolean
  /** 语义相位。 */
  phase: EventPhase
  /** 调用方（由栈重建得出）；无则 null。 */
  from: string | null
  /** 接收方；无则 null。 */
  to: string | null
  /** 图上显示用的短标签。 */
  label: string
  /** 完整细节（不截断语义，仅限长度）。 */
  detail: string
  /** 耗时（毫秒）；无则 null。 */
  durationMs: number | null
  /** 成功与否；无法判断时为 null（未知不等于成功）。 */
  ok: boolean | null
  /**
   * 分段耗时（一次事件内部的阶段拆分），如「抢占+载入=1ms / 核验=6ms / 落库=24ms」。
   *
   * 它的价值：单条事件的**总耗时**只能说明"慢"，分段才能说明"**慢在哪一段**"——
   * 这是第二战场（定位可优化空间）最直接的证据形态。
   */
  segments: Array<{ name: string; ms: number }>
  /** 证据锚点。 */
  evidence: Evidence
}

/** 解析覆盖度：**让 AI 知道自己没看到什么**，这是本产品的强制披露项。 */
export interface Coverage {
  /** 源文件总行数。 */
  totalLines: number
  /** 被识别为日志记录起始的行数。 */
  recordLines: number
  /** 作为续行/堆栈并入上一条的行数。 */
  continuationLines: number
  /** 既非记录起始、也无上一条可挂靠的行数（真正的漏网）。 */
  orphanLines: number
  /**
   * 解析成功率 = `recordLines / (recordLines + orphanLines)`。
   *
   * 刻意**不把续行/堆栈计入分母**：续行是被正确吞并的内容，不是失败。
   * 若把堆栈算作失败，堆栈密集的日志会永远报 failed，进而训练使用者忽略告警（告警疲劳）。
   */
  ratio: number
  /** 漏网行样本（最多若干条），供 AI 与人工定位格式漂移。 */
  orphanSamples: Array<{ line: number; text: string }>
}

/** 覆盖度判定阈值：低于此值视为解析失效，必须显式失败而非返回空结果。 */
export const COVERAGE_FLOOR = 0.5

/** 覆盖度结论。 */
export type CoverageVerdict = 'ok' | 'degraded' | 'failed'

/**
 * 依据覆盖度给出结论。
 *
 * 三档语义：`ok` = 可信；`degraded` = 部分可信（有漏网但主体可用）；
 * `failed` = **不可信**——此时上层必须回报「解析失效」，禁止把空结果当作「系统没问题」。
 *
 * @param coverage - 覆盖度统计。
 * @returns 覆盖度结论。
 */
export function judgeCoverage(coverage: Coverage): CoverageVerdict {
  if (coverage.recordLines === 0) return 'failed'
  if (coverage.ratio < COVERAGE_FLOOR) return 'failed'
  return coverage.orphanLines > 0 ? 'degraded' : 'ok'
}

/** 一个案例（一次请求/一张单据/一个会话）的事实集合。 */
export interface CaseFacts {
  /** 案例标识；空的 caseId 归入 `(no-case)`。 */
  caseId: string
  /** 事件列表（按出现顺序）。 */
  events: RuntimeEvent[]
  /** 该案例内的方法级调用次数（phase = call）。 */
  callCount: number
  /** 该案例内的异常数（phase = exception）。 */
  exceptionCount: number
  /** 该案例内可累加的耗时（毫秒），仅统计终态事件。 */
  totalMs: number
}

/** 事件 ID 生成：只用来源与行号，保证「改文案不改身份」。 */
export function makeEventId(source: string, line: number): string {
  return `${source}#${line}`
}

/** 截断文本用于证据片段，避免产物膨胀；截断行为显式标注。 */
export function clipSnippet(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…(截断)` : flat
}

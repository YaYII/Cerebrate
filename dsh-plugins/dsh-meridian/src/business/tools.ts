/**
 * Meridian 工具编排层 —— 把摄取/判定/指纹能力包装成 AI 可直接调用的四个工具。
 *
 * 本文件干什么：读文件、选接入声明、调用 features 层、把结果整理成**有界、带证据、带覆盖度**的返回。
 * 本文件不干什么：不含解析或判定逻辑（都在 features/），不修改被观测项目。
 *
 * 四条不可协商的返回约束（来自竞品调研与真实语料教训）：
 * 1. **覆盖度必披露**：任何事实结果都必须附带「解析了多少 / 漏了多少 / 漏网样本」；
 * 2. **失效必显式**：覆盖度不足时 `verdict = failed`，并明确写「不可作为系统无问题的依据」；
 * 3. **响应必有界**：事件按 limit/offset 分页，并回报 total，绝不静默截断；
 * 4. **事实必带证据**：每条事实带 `来源:行号` 与脱敏后的原文片段。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { existsSync, readFileSync } from 'node:fs'
import { buildFingerprint, compareFingerprints } from '../features/fingerprint'
import { ingestLogText, NO_CASE, type IngestResult } from '../features/ingest'
import type { Coverage } from '../features/eventModel'
import { judgeCase, type Intent, type Verdict } from '../features/ruler'
import type { RulePack } from '../features/rulePack'
import { DSEDT_INTENTS } from '../packs/dsedtIntent'
import { DSEDT_PACK } from '../packs/dsedtJavaLogback'
import { IHM2_PACK } from '../packs/ihm2Laravel'

/**
 * 校验并规范化外部传入的接入声明。
 *
 * 为什么必须校验：工具参数来自模型生成的 JSON，属**不可信边界输入**。
 * 直接断言类型（as RulePack）会把错误推迟到解析中途，产生难以定位的空结果；
 * 这里显式校验并抛出可读错误，让 AI 立刻知道该怎么改。
 *
 * @param raw - 外部传入的声明对象。
 * @returns 校验通过的接入声明。
 * @throws 当缺字段或字段类型不对时抛错，错误信息指出具体缺什么。
 */
export function parsePackDefinition(raw: unknown): RulePack {
  if (raw === null || typeof raw !== 'object') throw new Error('definition 必须是对象')
  const obj = raw as Record<string, unknown>
  if (typeof obj.name !== 'string' || obj.name === '') throw new Error('definition.name 必须是非空字符串')
  if (!Array.isArray(obj.formats) || obj.formats.length === 0) throw new Error('definition.formats 必须是非空数组')
  for (const item of obj.formats) {
    const format = item as Record<string, unknown>
    if (typeof format?.name !== 'string' || typeof format?.declaration !== 'string') {
      throw new Error('definition.formats 的每一项都必须含 name 与 declaration（字符串）')
    }
  }
  if (!Array.isArray(obj.rules)) throw new Error('definition.rules 必须是数组（可为空）')
  for (const item of obj.rules) {
    const rule = item as Record<string, unknown>
    if (typeof rule?.name !== 'string' || typeof rule?.phase !== 'string' || typeof rule?.pattern !== 'string') {
      throw new Error('definition.rules 的每一项都必须含 name / phase / pattern（字符串）')
    }
  }
  return obj as unknown as RulePack
}

/**
 * 校验并规范化外部传入的意图声明。
 *
 * @param raw - 外部传入的意图数组。
 * @returns 校验通过的意图声明。
 * @throws 当结构不合法时抛错并指出位置。
 */
export function parseIntents(raw: unknown): Intent[] {
  if (!Array.isArray(raw)) throw new Error('intents 必须是数组')
  return raw.map((item, index) => {
    const intent = item as Record<string, unknown>
    if (typeof intent?.name !== 'string') throw new Error(`intents[${index}].name 必须是字符串`)
    if (!Array.isArray(intent.expect)) throw new Error(`intents[${index}].expect 必须是数组`)
    for (const [stepIndex, step] of (intent.expect as unknown[]).entries()) {
      const shape = step as Record<string, unknown>
      if (typeof shape?.name !== 'string') throw new Error(`intents[${index}].expect[${stepIndex}].name 必须是字符串`)
      if (shape.match === null || typeof shape.match !== 'object') {
        throw new Error(`intents[${index}].expect[${stepIndex}].match 必须是对象`)
      }
    }
    return intent as unknown as Intent
  })
}

/** 可 JSON 化的值（工具契约就是 JSON，用它约束出口）。 */
export type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike }

/**
 * 把编排结果规范化为纯 JSON 值。
 *
 * 两件事：① 断言出口可序列化（工具契约要求）；② 顺带剔除 `undefined` 字段，
 * 避免下游把「字段缺失」与「字段为 undefined」混为一谈。
 *
 * @param payload - 编排层组装的任意结果对象。
 * @returns 可安全返回给工具调用方的 JSON 值。
 */
export function toJsonResult(payload: unknown): Record<string, JsonLike> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, JsonLike>
}

/** 内置接入声明登记表。 */
const BUILTIN_PACKS: Record<string, RulePack> = {
  dsedt: DSEDT_PACK,
  ihm2: IHM2_PACK,
}

/** 内置意图登记表（仅 DSEDT 目前有成文意图）。 */
const BUILTIN_INTENTS: Record<string, Intent[]> = {
  dsedt: DSEDT_INTENTS,
  ihm2: [],
}

/** 工具入参：接入方式（内置名或内联声明）。 */
export interface PackArgs {
  /** 内置接入名（`dsedt` / `ihm2`）。 */
  pack?: string
  /** 内联接入声明（未内置的第三方系统用这个）。 */
  definition?: RulePack
}

/** 事实查询入参。 */
export interface FactsArgs extends PackArgs {
  /** 日志文件路径（必填）。 */
  log: string
  /** 视角：技术案例 / 业务对象 / 仅覆盖度。 */
  view?: 'case' | 'object' | 'coverage'
  /** 只看某个案例或业务对象。 */
  id?: string
  /** 分页起止。 */
  offset?: number
  /** 分页大小（默认 20，上限 200）。 */
  limit?: number
}

/** 判定入参。 */
export interface VerdictArgs extends PackArgs {
  /** 日志文件路径。 */
  log: string
  /** 自定义意图声明；缺省用内置意图。 */
  intents?: Intent[]
}

/** 基线对比入参。 */
export interface BaselineArgs extends PackArgs {
  /** 当前日志。 */
  log: string
  /** 基线日志（上一次运行产物）。 */
  baseline: string
}

/** 分页上限。 */
const MAX_LIMIT = 200

/** 读取日志文件（不存在时给出显式错误，不返回空结果）。 */
function readLog(path: string): string {
  if (!existsSync(path)) throw new Error(`日志文件不存在：${path}`)
  return readFileSync(path, 'utf8')
}

/** 解析接入声明：优先内联，其次内置。 */
function resolvePack(args: { pack?: string; definition?: unknown }): RulePack {
  if (args.definition !== undefined) {
    // 已由调用方校验过则直接用；否则按不可信输入处理
    return parsePackDefinition(args.definition)
  }
  const name = args.pack ?? 'dsedt'
  const pack = BUILTIN_PACKS[name]
  if (pack === undefined) {
    throw new Error(`未知接入名「${name}」。可选：${Object.keys(BUILTIN_PACKS).join(', ')}；或通过 definition 传入内联声明。`)
  }
  return pack
}

/** 覆盖度的人类可读摘要（强制随结果返回）。 */
function coverageSummary(coverage: Coverage, verdict: IngestResult['verdict']): string {
  const percent = (coverage.ratio * 100).toFixed(2)
  const base = `解析率 ${percent}%（记录 ${coverage.recordLines} 行 / 续行 ${coverage.continuationLines} 行 / 漏网 ${coverage.orphanLines} 行）｜结论 ${verdict}`
  return verdict === 'failed'
    ? `${base} —— ⚠ 事实不可信，**不可作为「系统无问题」的依据**`
    : base
}

/** 事实查询：返回有界、带证据、带覆盖度的运行时事实。 */
export function merFacts(args: FactsArgs): Record<string, JsonLike> {
  const pack = resolvePack(args)
  const result = ingestLogText(readLog(args.log), { source: args.log, pack })
  const view = args.view ?? 'case'
  const limit = Math.min(args.limit ?? 20, MAX_LIMIT)
  const offset = Math.max(args.offset ?? 0, 0)

  const payload: Record<string, unknown> = {
    log: args.log,
    pack: pack.name,
    formatUsed: result.formatUsed,
    formatAttempts: result.formatAttempts,
    coverage: result.coverage,
    coverageNote: coverageSummary(result.coverage, result.verdict),
    verdict: result.verdict,
    warnings: result.warnings,
    eventCount: result.eventCount,
    caseCount: result.caseCount,
    objectCount: result.objectCases.length,
  }
  if (view === 'coverage') return toJsonResult(payload)

  if (view === 'object') {
    const list = args.id === undefined ? result.objectCases : result.objectCases.filter((item) => item.caseId === args.id)
    payload.total = list.length
    payload.offset = offset
    payload.limit = limit
    payload.objects = list.slice(offset, offset + limit).map((item) => ({
      objectId: item.caseId,
      eventCount: item.events.length,
      attributableMs: item.totalMs,
      timeline: item.events.map((event) => ({
        label: event.label,
        phase: event.phase,
        durationMs: event.durationMs,
        evidence: `${event.evidence.source}:${event.evidence.line}`,
        snippet: event.evidence.snippet,
      })),
    }))
    return toJsonResult(payload)
  }

  const list = args.id === undefined ? result.cases : result.cases.filter((item) => item.caseId === args.id)
  payload.total = list.length
  payload.offset = offset
  payload.limit = limit
  payload.cases = list.slice(offset, offset + limit).map((item) => ({
    caseId: item.caseId === NO_CASE ? NO_CASE : item.caseId,
    eventCount: item.events.length,
    callCount: item.callCount,
    exceptionCount: item.exceptionCount,
    attributableMs: item.totalMs,
    events: item.events.slice(0, 50).map((event) => ({
      seq: event.seq,
      phase: event.phase,
      level: event.level,
      label: event.label,
      objectId: event.objectId,
      durationMs: event.durationMs,
      ok: event.ok,
      evidence: `${event.evidence.source}:${event.evidence.line}`,
      snippet: event.evidence.snippet,
    })),
  }))
  return toJsonResult(payload)
}

/** 意图判定：把「AI 声明的意图」与「运行期事实」对比，产出可复核判定。 */
export function merVerdict(args: VerdictArgs): Record<string, JsonLike> {
  const pack = resolvePack(args)
  const result = ingestLogText(readLog(args.log), { source: args.log, pack })
  const intents = args.intents ?? BUILTIN_INTENTS[args.pack ?? 'dsedt'] ?? []
  if (intents.length === 0) {
    return toJsonResult({
      log: args.log,
      coverageNote: coverageSummary(result.coverage, result.verdict),
      verdict: result.verdict,
      note: '未提供意图声明，且该接入名无内置意图。请通过 intents 传入「期望步骤序列」后再判定。',
      verdicts: [],
    })
  }
  const verdicts: Verdict[] = []
  for (const facts of result.cases) {
    for (const intent of intents) {
      verdicts.push(judgeCase(intent, facts, result.verdict))
    }
  }
  const judged = verdicts.filter((item) => item.status !== 'out-of-scope')
  return toJsonResult({
    log: args.log,
    pack: pack.name,
    coverageNote: coverageSummary(result.coverage, result.verdict),
    verdict: result.verdict,
    intentCount: intents.length,
    caseCount: result.cases.length,
    summary: {
      pass: judged.filter((item) => item.status === 'pass').length,
      deviated: judged.filter((item) => item.status === 'deviated').length,
      failed: judged.filter((item) => item.status === 'failed').length,
      inconclusive: verdicts.filter((item) => item.status === 'inconclusive').length,
      outOfScope: verdicts.filter((item) => item.status === 'out-of-scope').length,
    },
    verdicts: verdicts.map((item) => ({
      caseId: item.caseId === NO_CASE ? NO_CASE : item.caseId,
      intent: item.intent,
      status: item.status,
      basis: item.basis,
      matched: item.matched,
      missing: item.missing,
      findings: item.findings.map((finding) => ({
        kind: finding.kind,
        severity: finding.severity,
        message: finding.message,
        expected: finding.expected,
        evidence: finding.evidence.map((ev) => `${ev.source}:${ev.line} → ${ev.snippet}`),
      })),
    })),
  })
}

/** 基线对比：区分「只是改名」与「行为真的变了」。 */
export function merBaseline(args: BaselineArgs): Record<string, JsonLike> {
  const pack = resolvePack(args)
  const current = ingestLogText(readLog(args.log), { source: args.log, pack })
  const base = ingestLogText(readLog(args.baseline), { source: args.baseline, pack })
  const delta = compareFingerprints(buildFingerprint(base.events), buildFingerprint(current.events))
  return toJsonResult({
    current: args.log,
    baseline: args.baseline,
    pack: pack.name,
    currentCoverage: coverageSummary(current.coverage, current.verdict),
    baselineCoverage: coverageSummary(base.coverage, base.verdict),
    currentSize: current.eventCount,
    baselineSize: base.eventCount,
    delta: {
      kind: delta.kind,
      summary: delta.summary,
      firstDivergence: delta.firstDivergence,
      baselineSample: delta.baseSample,
      currentSample: delta.currentSample,
    },
    howToRead:
      'identical=行为未变；relabeled=结构未变仅文案变化（低置信，建议人工确认）；' +
      'length-changed=多做或少做了步骤（高置信）；structure-changed=执行结构变化（高置信）。',
  })
}

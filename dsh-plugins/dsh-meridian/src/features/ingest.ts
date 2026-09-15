/**
 * 日志摄取砖块 —— 把一段日志文本变成「带证据的运行时事件 + 案例 + 覆盖度结论」。
 *
 * 本文件干什么：选格式 → 合并续行 → 按规则产出事件 → 重建调用栈 → 统计覆盖度并给结论。
 * 本文件不干什么：不读文件、不落盘、不认识任何具体项目（格式与规则均由规则包注入）。
 *
 * 强制约束：**当解析失效时必须显式失败**（verdict = failed），
 * 绝不允许把「一条都没解析出来」当成「系统没有问题」——这是本产品要根治的头号沉默故障。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import {
  clipSnippet,
  judgeCoverage,
  makeEventId,
  type CaseFacts,
  type Coverage,
  type CoverageVerdict,
  type RuntimeEvent,
} from './eventModel'
import { parseLogLine, type CompiledFormat, type ParsedRecord } from './logFormat'
import { compileRulePack, renderTemplate, type CompiledRulePack, type RulePack } from './rulePack'

/** 无链路标识时的占位案例名。 */
export const NO_CASE = '(no-case)'

/** 摄取选项。 */
export interface IngestOptions {
  /** 证据来源名（通常是日志文件路径）。 */
  source: string
  /** 接入声明（格式 + 规则）。 */
  pack: RulePack
  /** 强制指定格式名；缺省则自动在候选格式中选择命中最多者。 */
  formatName?: string
  /** 漏网行样本上限（默认 20）。 */
  orphanSampleLimit?: number
}

/** 一次格式尝试的结果。 */
export interface FormatAttempt {
  /** 格式名。 */
  format: string
  /** 命中行数。 */
  hits: number
  /** 是否被选中。 */
  selected: boolean
}

/** 摄取结果。 */
export interface IngestResult {
  /** 证据来源。 */
  source: string
  /** 实际使用的格式名；全部候选都零命中时为 null。 */
  formatUsed: string | null
  /** 各候选格式的尝试记录（**披露**：让人与 AI 看到为什么选了它）。 */
  formatAttempts: FormatAttempt[]
  /** 覆盖度统计。 */
  coverage: Coverage
  /** 覆盖度结论。 */
  verdict: CoverageVerdict
  /** 事件总数。 */
  eventCount: number
  /** 事件列表（按出现顺序，保留插入序）。 */
  events: RuntimeEvent[]
  /** 案例数。 */
  caseCount: number
  /** 按案例聚合的事实。 */
  cases: CaseFacts[]
  /** 告警（不阻断，但必须回显给消费者）。 */
  warnings: string[]
}

/** 内部：带原始行的解析记录。 */
interface LineRecord {
  parsed: ParsedRecord
  /** 合并后的完整文本（含续行）。 */
  text: string
  /** 涉及行数。 */
  lineCount: number
}

/** 统计某格式在一段文本上的命中行数（用于格式选择）。 */
function countHits(lines: string[], format: CompiledFormat): number {
  let hits = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (parseLogLine(lines[i], format, i + 1) !== null) hits += 1
  }
  return hits
}

/** 选出命中最多的格式；全为 0 时返回 null。 */
function selectFormat(
  lines: string[],
  formats: CompiledFormat[],
  forced?: string,
): { format: CompiledFormat | null; attempts: FormatAttempt[] } {
  if (forced !== undefined) {
    const target = formats.find((item) => item.name === forced) ?? null
    const attempts = formats.map((item) => ({
      format: item.name,
      hits: countHits(lines, item),
      selected: item.name === forced,
    }))
    return { format: target, attempts }
  }
  const attempts: FormatAttempt[] = []
  let best: CompiledFormat | null = null
  let bestHits = 0
  for (const item of formats) {
    const hits = countHits(lines, item)
    attempts.push({ format: item.name, hits, selected: false })
    if (hits > bestHits) {
      bestHits = hits
      best = item
    }
  }
  if (best !== null) {
    for (const attempt of attempts) attempt.selected = attempt.format === best.name
  }
  return { format: best, attempts }
}

/** 合并续行（无格式前缀的行并入上一条）；返回记录与漏网统计。 */
function buildRecords(
  lines: string[],
  format: CompiledFormat | null,
): { records: LineRecord[]; recordLines: number; continuationLines: number; orphans: Array<{ line: number; text: string }> } {
  const records: LineRecord[] = []
  let recordLines = 0
  let continuationLines = 0
  const orphans: Array<{ line: number; text: string }> = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim().length === 0) continue
    const parsed = format === null ? null : parseLogLine(raw, format, i + 1)
    if (parsed !== null) {
      recordLines += 1
      records.push({ parsed, text: parsed.message, lineCount: 1 })
      continue
    }
    const last = records[records.length - 1]
    if (last !== undefined) {
      continuationLines += 1
      last.text = `${last.text}\n${raw}`
      last.lineCount += 1
    } else {
      orphans.push({ line: i + 1, text: clipSnippet(raw, 160) })
    }
  }
  return { records, recordLines, continuationLines, orphans }
}

/** 取 logger 的类简名。 */
function simpleName(logger: string): string {
  const idx = logger.lastIndexOf('.')
  return idx >= 0 ? logger.slice(idx + 1) : logger
}

/** 按规则匹配一条记录，产出事件所需字段。 */
function classify(
  record: LineRecord,
  rules: CompiledRulePack['rules'],
  stack: string[],
): { rule: string; phase: RuntimeEvent['phase']; label: string; detail: string; durationMs: number | null; ok: boolean | null; from: string | null; to: string | null; actor: string } {
  const { parsed, text } = record
  for (const rule of rules) {
    const matched = rule.regex.exec(text)
    if (matched === null) continue
    const groups: Record<string, string | undefined> = { ...(matched.groups ?? {}) }
    const actor = rule.actor === 'logger' ? simpleName(parsed.logger) : stack[stack.length - 1] ?? simpleName(parsed.logger)
    const durationRaw = rule.durationField === undefined ? undefined : groups[rule.durationField]
    const durationMs = durationRaw === undefined || durationRaw === '' ? null : Number.parseInt(durationRaw, 10)
    const okRaw = rule.okField === undefined ? undefined : groups[rule.okField]
    const ok = okRaw === undefined || rule.okEquals === undefined ? null : okRaw === rule.okEquals
    const from = rule.stackPop === true ? stack[stack.length - 2] ?? null : stack[stack.length - 1] ?? null
    return {
      rule: rule.name,
      phase: rule.phase,
      label: rule.label === undefined ? clipSnippet(text, 120) : renderTemplate(rule.label, groups),
      detail: rule.detail === undefined ? text : renderTemplate(rule.detail, groups),
      durationMs: Number.isNaN(durationMs as number) ? null : durationMs,
      ok,
      from,
      to: rule.phase === 'return' || rule.phase === 'exception' ? from : actor,
      actor,
    }
  }
  const actor = simpleName(parsed.logger)
  return {
    rule: '(no-rule)',
    phase: 'log',
    label: clipSnippet(text, 120),
    detail: text,
    durationMs: null,
    ok: parsed.level === 'ERROR' ? false : null,
    from: stack[stack.length - 1] ?? null,
    to: null,
    actor,
  }
}

/**
 * 摄取一段日志文本。
 *
 * @param text - 日志全文（可含多行堆栈）。
 * @param options - 摄取选项。
 * @returns 摄取结果（事件、案例、覆盖度、告警）。
 */
export function ingestLogText(text: string, options: IngestOptions): IngestResult {
  const compiled = compileRulePack(options.pack)
  const lines = text.split(/\r?\n/)
  const { format, attempts } = selectFormat(lines, compiled.formats, options.formatName)
  const { records, recordLines, continuationLines, orphans } = buildRecords(lines, format)

  const warnings: string[] = []
  const stack: string[] = []
  const events: RuntimeEvent[] = []
  let missingCase = 0

  for (const record of records) {
    const { parsed } = record
    if (parsed.traceId === '') missingCase += 1
    const outcome = classify(record, compiled.rules, stack)
    if (outcome.phase === 'call') stack.push(outcome.actor)
    if (outcome.phase === 'return' || outcome.phase === 'exception') stack.pop()
    events.push({
      id: makeEventId(options.source, parsed.line),
      seq: events.length + 1,
      ts: parsed.time,
      level: parsed.level,
      logger: parsed.logger,
      thread: parsed.thread,
      caseId: parsed.traceId,
      phase: outcome.phase,
      from: outcome.from,
      to: outcome.to,
      label: outcome.label,
      detail: clipSnippet(outcome.detail, 400),
      durationMs: outcome.durationMs,
      ok: outcome.ok,
      evidence: {
        source: options.source,
        line: parsed.line,
        lineCount: record.lineCount,
        snippet: clipSnippet(record.text, 200),
      },
    })
  }

  const coverage: Coverage = {
    totalLines: lines.filter((line) => line.trim().length > 0).length,
    recordLines,
    continuationLines,
    orphanLines: orphans.length,
    // 分母只含「本应成为记录起始」的行：记录行 + 漏网行；续行单独披露不计入。
    ratio: recordLines + orphans.length === 0 ? 0 : recordLines / (recordLines + orphans.length),
    orphanSamples: orphans.slice(0, options.orphanSampleLimit ?? 20),
  }
  const verdict = judgeCoverage(coverage)

  if (verdict === 'failed') {
    warnings.push(
      `解析失效：${coverage.totalLines} 行中仅 ${recordLines} 行被识别为日志记录（候选格式命中：${attempts
        .map((item) => `${item.format}=${item.hits}`)
        .join(', ')}）。**此结果不可作为「系统无问题」的依据。**`,
    )
  } else if (verdict === 'degraded') {
    warnings.push(`部分行未识别（${coverage.orphanLines} 行），存在格式漂移或非日志输出。`)
  }
  if (missingCase > 0) {
    warnings.push(
      `${missingCase} 条事件缺少链路标识（traceId 为空），无法按案例聚合；` +
        `常见原因：该运行态未经过 TraceFilter（如单元测试、异步线程、无 MDC 的入口）。`,
    )
  }

  return {
    source: options.source,
    formatUsed: format === null ? null : format.name,
    formatAttempts: attempts,
    coverage,
    verdict,
    eventCount: events.length,
    events,
    caseCount: new Set(events.map((event) => event.caseId === '' ? NO_CASE : event.caseId)).size,
    cases: groupCases(events),
    warnings,
  }
}

/** 把事件按案例聚合，并统计调用数、异常数、可累加耗时。 */
function groupCases(events: RuntimeEvent[]): CaseFacts[] {
  const map = new Map<string, RuntimeEvent[]>()
  for (const event of events) {
    const key = event.caseId === '' ? NO_CASE : event.caseId
    const list = map.get(key)
    if (list === undefined) map.set(key, [event])
    else list.push(event)
  }
  const result: CaseFacts[] = []
  for (const [caseId, list] of map) {
    let totalMs = 0
    let callCount = 0
    let exceptionCount = 0
    for (const event of list) {
      if (event.phase === 'call') callCount += 1
      if (event.phase === 'exception') exceptionCount += 1
      if (event.durationMs !== null && (event.phase === 'return' || event.phase === 'request-out' || event.phase === 'step' || event.phase === 'step-end')) {
        totalMs += event.durationMs
      }
    }
    result.push({ caseId, events: list, callCount, exceptionCount, totalMs })
  }
  return result
}

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
import { redactLine } from './redact'
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
  /** 按**技术案例**（traceId）聚合的事实。 */
  cases: CaseFacts[]
  /**
   * 按**业务对象**（单据号等）聚合的事实 —— 「一张单据的一生」。
   *
   * 与 `cases` 并列存在而非二选一，因为二者是多对多关系：
   * 真实语料里 179 个技术案例只对应 15 个业务对象。
   */
  objectCases: CaseFacts[]
  /** 告警（不阻断，但必须回显给消费者）。 */
  warnings: string[]
}

/**
 * 常见的掩码标记（被观测系统自身的脱敏产物）。
 *
 * 真实案例（2026-09-14 DSEDT 生产日志）：同一个 `orderNo` 在 5 行里是完整值，
 * 在 1 行里被应用自己写成 `ORD-9006aa…（已脱敏）`——若原样使用，
 * **同一张单据会被识别成两个业务对象**，生命周期被切断。
 */
const MASK_MARKERS: readonly RegExp[] = [
  /…/, // 如 `ORD-9006aa…（已脱敏）`
  /\.{3,}/, // 如 `ORD-9006aa...`
  /\*{2,}/, // 如 `ORD-****`
]

/** 判断一个标识是否含掩码标记。 */
function hasMaskMarker(value: string): boolean {
  return MASK_MARKERS.some((marker) => marker.test(value));
}

/**
 * 用包级声明从消息里抽取业务对象标识（**原样返回，不做消歧**）。
 *
 * 消歧放在收齐全部事实之后统一进行（见 `unifyMaskedObjects`）：
 * 抽取阶段信息不全，任何"就地猜测"都可能把两张单据合并。
 *
 * @param text - 消息体。
 * @param spec - 包级抽取声明。
 * @returns 抽到的原始标识；未命中返回空串。
 */
function extractObjectId(text: string, spec: { pattern: string; group: string } | undefined): string {
  if (spec === undefined) return ''
  return new RegExp(spec.pattern).exec(text)?.groups?.[spec.group]?.trim() ?? ''
}

/**
 * 掩码标识消歧：把「被掩码截断的标识」归并到唯一的完整标识上。
 *
 * 规则（保守，宁可不错）：
 * - 掩码值 `M` 若**恰好是某一个**完整标识的前缀 → 归并为该完整标识；
 * - 若匹配 0 个或多个完整标识 → **保持原样**（不猜），并计入 `ambiguous` 由上层披露。
 *
 * 真实动因（2026-09-14 DSEDT 生产日志）：同一 `orderNo` 在 5 行里是完整值，
 * 在 1 行里被应用自己的脱敏写成 `ORD-9006aa…（已脱敏）`——
 * 不消歧会把**同一张单据识别成两个业务对象**，生命周期被切断。
 *
 * @param events - 事件序列（就地修改 objectId）。
 * @returns 消歧统计，供披露使用。
 */
function unifyMaskedObjects(events: RuntimeEvent[]): { masked: number; unified: number; ambiguous: number } {
  const maskedEvents = events.filter((event) => event.objectIdMasked)
  if (maskedEvents.length === 0) return { masked: 0, unified: 0, ambiguous: 0 }
  const fullIds = [...new Set(events.filter((event) => !event.objectIdMasked && event.objectId !== '').map((event) => event.objectId))]
  let unified = 0
  let ambiguous = 0
  for (const event of maskedEvents) {
    // 先剥离掩码标记再做前缀匹配：标记本身不属于标识内容
    // （如 `ORD-9006aa…（已脱敏）` → 前缀 `ORD-9006aa`）
    const prefix = event.objectId.replace(/….*$/, '').replace(/\.{3,}.*$/, '').replace(/\*{2,}.*$/, '').trim()
    if (prefix === '') {
      ambiguous += 1
      continue
    }
    const candidates = fullIds.filter((full) => full.startsWith(prefix))
    if (candidates.length === 1) {
      event.objectId = candidates[0]
      event.objectIdMasked = false
      unified += 1
    } else {
      // 不唯一就不猜：保留原值（含标记），由上层披露
      event.objectId = prefix
      ambiguous += 1
    }
  }
  return { masked: maskedEvents.length, unified, ambiguous }
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
  fallbacks: CompiledFormat[] = [],
): { records: LineRecord[]; recordLines: number; continuationLines: number; orphans: Array<{ line: number; text: string }>; fallbackLines: number } {
  /** 依次尝试主格式与回退格式。 */
  const parseWithFallback = (raw: string, lineNo: number): ReturnType<typeof parseLogLine> => {
    if (format !== null) {
      const primary = parseLogLine(raw, format, lineNo)
      if (primary !== null) return primary
    }
    for (const candidate of fallbacks) {
      const parsed = parseLogLine(raw, candidate, lineNo)
      if (parsed !== null) return parsed
    }
    return null
  }
  const records: LineRecord[] = []
  let recordLines = 0
  let continuationLines = 0
  let fallbackLines = 0
  const orphans: Array<{ line: number; text: string }> = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim().length === 0) continue
    const primaryParsed = format === null ? null : parseLogLine(raw, format, i + 1)
    const parsed = primaryParsed ?? parseWithFallback(raw, i + 1)
    if (parsed !== null && primaryParsed === null) fallbackLines += 1
    if (parsed !== null) {
      recordLines += 1
      records.push({ parsed, text: parsed.message, lineCount: 1 })
      continue
    }
    const last = records[records.length - 1]
    // 关键区分：**形似日志头却未匹配**的行是「格式漂移导致的漏解析」，必须计为漏网；
    // 否则它会被当成上一条的续行静默吞掉，覆盖率虚高——静默失效换了个形式又回来了（实测踩过）。
    if (last !== undefined && !looksLikeLogHeader(raw)) {
      continuationLines += 1
      last.text = `${last.text}\n${raw}`
      last.lineCount += 1
    } else {
      orphans.push({ line: i + 1, text: clipSnippet(raw, 160) })
    }
  }
  return { records, recordLines, continuationLines, orphans, fallbackLines }
}

/**
 * 判断一行是否「形似日志头」——形似却未匹配，说明声明的格式与真实日志已经漂移。
 *
 * 判据取常见的两种时间开头：`[2026-09-15 10:24:59]` 与 `[10:24:59.123]` / `14:48:34.653`。
 *
 * @param line - 原始行。
 * @returns 是否形似日志头。
 */
function looksLikeLogHeader(line: string): boolean {
  return /^\[?\d{4}-\d{2}-\d{2}[ T]/.test(line) || /^\[?\d{2}:\d{2}:\d{2}[.,]/.test(line)
}

/**
 * 按声明抽取分段耗时。
 *
 * @param text - 消息体。
 * @param spec - 分段抽取声明。
 * @returns 分段列表（最多 20 段，防止异常日志把事实撑爆）。
 */
function extractSegments(
  text: string,
  spec: { pattern: string; nameGroup: string; valueGroup: string; ignore?: string[] } | undefined,
): Array<{ name: string; ms: number }> {
  if (spec === undefined) return []
  const regex = new RegExp(spec.pattern, 'g')
  const result: Array<{ name: string; ms: number }> = []
  let matched = regex.exec(text)
  while (matched !== null && result.length < 20) {
    const name = matched.groups?.[spec.nameGroup]
    const value = matched.groups?.[spec.valueGroup]
    if (name !== undefined && value !== undefined) {
      const ms = Number.parseFloat(value)
      const trimmed = name.trim()
      const ignored = (spec.ignore ?? []).some((item) => trimmed.includes(item))
      if (!Number.isNaN(ms) && !ignored) result.push({ name: trimmed, ms })
    }
    matched = regex.exec(text)
  }
  return result
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
): { rule: string; phase: RuntimeEvent['phase']; label: string; detail: string; durationMs: number | null; ok: boolean | null; from: string | null; to: string | null; actor: string; caseId: string | null; objectId: string | null; segments: Array<{ name: string; ms: number }> } {
  const { parsed, text } = record
  for (const rule of rules) {
    const matched = rule.regex.exec(text)
    if (matched === null) continue
    const groups: Record<string, string | undefined> = { ...(matched.groups ?? {}) }
    const actor = rule.actor === 'logger' ? simpleName(parsed.logger) : stack[stack.length - 1] ?? simpleName(parsed.logger)
    const durationRaw = rule.durationField === undefined ? undefined : groups[rule.durationField]
    // 用 parseFloat 而非 parseInt：真实日志存在亚毫秒精度（如 IHM2 的 duration_ms=58.57），
    // 截断会丢失源数据精度——证据应当忠实于原始值，四舍五入留给展示层。
    const durationMs = durationRaw === undefined || durationRaw === '' ? null : Number.parseFloat(durationRaw)
    const okRaw = rule.okField === undefined ? undefined : groups[rule.okField]
    // 成败判定支持两种声明：等值（`okEquals`）与区间（`okPattern`，如 HTTP 2xx/3xx 视为成功）。
    // 两者都未声明时必须是 null——**未知不等于成功**，否则失败会被静默算作正常。
    let ok: boolean | null = null
    if (okRaw !== undefined && rule.okEquals !== undefined) ok = okRaw === rule.okEquals
    else if (okRaw !== undefined && rule.okRegex !== null) ok = rule.okRegex.test(okRaw)
    // 案例标识既可来自行首（Java/MDC），也可来自消息体（PHP/JSON 上下文）
    const caseIdRaw = rule.caseIdField === undefined ? undefined : groups[rule.caseIdField]
    const caseId = caseIdRaw !== undefined && caseIdRaw !== '' ? caseIdRaw : null
    const objectIdRaw = rule.objectIdField === undefined ? undefined : groups[rule.objectIdField]
    const objectId = objectIdRaw !== undefined && objectIdRaw !== '' ? objectIdRaw : null
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
      caseId,
      objectId,
      segments: extractSegments(text, rule.segments),
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
    caseId: null,
    objectId: null,
    segments: [],
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
  // 回退候选：除主格式外的其它声明格式。真实日志常混用多种格式（配置变更/多组件），
  // 只认一种会让另一部分静默变成「漏网」——实测 Python 日志因此丢了 110/497 行。
  const fallbacks = compiled.formats.filter((item) => item !== format)
  const { records, recordLines, continuationLines, orphans, fallbackLines } = buildRecords(lines, format, fallbacks)

  const warnings: string[] = []
  const stack: string[] = []
  const events: RuntimeEvent[] = []
  let missingCase = 0

  for (const record of records) {
    const { parsed } = record
    const outcome = classify(record, compiled.rules, stack)
    // 有效案例标识：优先行首 traceId（Java/MDC），其次规则从消息抽取（PHP/JSON）
    const caseId = parsed.traceId !== '' ? parsed.traceId : (outcome.caseId ?? '')
    if (caseId === '') missingCase += 1
    const extracted = extractObjectId(record.text, compiled.pack.objectId)
    const resolvedValue = outcome.objectId ?? (extracted !== '' ? extracted : parsed.objectId) ?? ''
    if (outcome.phase === 'call') stack.push(outcome.actor)
    if (outcome.phase === 'return' || outcome.phase === 'exception') stack.pop()
    events.push({
      id: makeEventId(options.source, parsed.line),
      seq: events.length + 1,
      ts: parsed.time,
      level: parsed.level,
      logger: parsed.logger,
      thread: parsed.thread,
      caseId,
      // 业务对象标识优先级：规则级抽取 > 包级通用抽取 > 格式自带（JSON Lines）
      objectId: resolvedValue,
      objectIdMasked: hasMaskMarker(resolvedValue),
      segments: outcome.segments,
      phase: outcome.phase,
      from: outcome.from,
      to: outcome.to,
      label: clipSnippet(redactLine(outcome.label), 120),
      detail: clipSnippet(redactLine(outcome.detail), 400),
      durationMs: outcome.durationMs,
      ok: outcome.ok,
      evidence: {
        source: options.source,
        line: parsed.line,
        lineCount: record.lineCount,
        snippet: clipSnippet(redactLine(record.text), 200),
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
  const maskStats = unifyMaskedObjects(events)
  if (maskStats.masked > 0) {
    warnings.push(
      `发现 ${maskStats.masked} 条事件的业务对象标识带**掩码标记**（被观测系统自身的脱敏产物，如 \`ORD-9006aa…（已脱敏）\`）：` +
        `其中 ${maskStats.unified} 条按「前缀唯一匹配」归并到完整标识，${maskStats.ambiguous} 条无法唯一确定（已保持原样，未猜测）。`,
    )
  }
  if (fallbackLines > 0) {
    warnings.push(
      `本文件混用了多种日志格式：${fallbackLines} 行由回退格式解析（候选命中：${attempts
        .map((item) => `${item.format}=${item.hits}`)
        .join(', ')}）。建议在接入声明中补齐全部格式变体。`,
    )
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
    objectCases: groupByObject(events),
    warnings,
  }
}

/**
 * 把事件按**业务对象**聚合（单据视角），只保留有对象标识的事件。
 *
 * @param events - 事件序列。
 * @returns 按业务对象聚合的事实列表。
 */
function groupByObject(events: RuntimeEvent[]): CaseFacts[] {
  const map = new Map<string, RuntimeEvent[]>()
  for (const event of events) {
    if (event.objectId === '') continue
    const list = map.get(event.objectId)
    if (list === undefined) map.set(event.objectId, [event])
    else list.push(event)
  }
  const result: CaseFacts[] = []
  for (const [objectId, list] of map) {
    result.push({ caseId: objectId, events: list, callCount: 0, exceptionCount: 0, totalMs: sumDuration(list) })
  }
  return result.sort((a, b) => b.events.length - a.events.length)
}

/** 累加一组事件里可归因的耗时（终态与步骤事件）。 */
function sumDuration(events: RuntimeEvent[]): number {
  let total = 0
  for (const event of events) {
    if (event.durationMs === null) continue
    if (event.phase === 'return' || event.phase === 'request-out' || event.phase === 'step' || event.phase === 'step-end') {
      total += event.durationMs
    }
  }
  return total
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
    let callCount = 0
    let exceptionCount = 0
    for (const event of list) {
      if (event.phase === 'call') callCount += 1
      if (event.phase === 'exception') exceptionCount += 1
    }
    result.push({ caseId, events: list, callCount, exceptionCount, totalMs: sumDuration(list) })
  }
  return result
}

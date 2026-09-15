#!/usr/bin/env node
/**
 * XES 导出驱动 —— 把运行期事实导出为 **XES 标准事件日志**，交给流程挖掘内核（PM4Py 等）。
 *
 * 本文件干什么：摄取日志 → 按案例切成 trace → 按 XES 1.0 写 XML。
 * 本文件不干什么：不做流程发现、不做合规性检查（那些交给成熟内核，不自己造）。
 *
 * ## 为什么要导 XES 而不是自定义 JSON
 *
 * XES（IEEE 1849 标准）是流程挖掘领域的交换格式，PM4Py / ProM / Apromore / Celonis 都直接读。
 * 用标准格式意味着**发现、对齐、变体分析、时间维度校验**这些成熟能力可以零成本复用，
 * 而不必自己实现（尤其 alignments 是同步积上的最短路搜索，重写既不划算也不可靠）。
 *
 * ## 一个关键映射：activity 取「归一化标签」而不是原始标签
 *
 * 原始标签每次运行都不同（含单号/耗时），直接用会让**每条 trace 都成为独立变体**，
 * 发现出来的模型毫无意义。归一化标签（`normalizeLabel`）只抹易变值、保留分类值，
 * 因此 `HTTP 200` 与 `HTTP 500` 是两个不同活动（正确），而两个不同单号是同一个活动（也正确）。
 *
 * 用法：
 *   tsx scripts/dev-export-xes.ts <日志文件> [--out <xes 路径>] [--pack dsedt|ihm2|json|python]
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { normalizeLabel } from '../src/features/fingerprint'
import { ingestLogText } from '../src/features/ingest'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'
import { IHM2_PACK } from '../src/packs/ihm2Laravel'
import { NODE_JSON_PACK } from '../src/packs/nodeJsonLines'
import { PYTHON_LOGGING_PACK } from '../src/packs/pythonLogging'

/** 可选接入声明：按 `--pack` 选择被观测系统。 */
const PACKS = {
  dsedt: DSEDT_PACK,
  ihm2: IHM2_PACK,
  python: PYTHON_LOGGING_PACK,
  json: NODE_JSON_PACK,
} as const

const args = process.argv.slice(2)
const file = args[0]
if (file === undefined) {
  process.stderr.write('用法：tsx scripts/dev-export-xes.ts <日志文件> [--out <xes 路径>] [--pack dsedt|ihm2|json|python]\n')
  process.exit(2)
}

/** 取具名参数值。 */
function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const packName = (option('--pack') ?? 'dsedt') as keyof typeof PACKS
const outPath = option('--out') ?? `/tmp/${basename(file).replace(/\.[^.]+$/, '')}.xes`
const source = basename(file)
const result = ingestLogText(readFileSync(file, 'utf8'), { source, pack: PACKS[packName] ?? DSEDT_PACK })

/** XML 文本转义（XES 是 XML，属性值里的 & < > " 必须转义，否则文件不可解析）。 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 把 `YYYY-MM-DD HH:mm:ss.SSS` 转为 XES 要求的 ISO-8601 带时区格式。
 *
 * 日志里的时间**没有时区**（本地墙钟），这里按本机时区补全——
 * 时间维度校验（temporal profile）依赖时间戳可比较，时区缺失会导致跨天数据错序。
 *
 * @param ts - 日志时间片段。
 * @returns ISO-8601 字符串；无法解析时返回空串（由调用方决定是否跳过）。
 */
function toIso(ts: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(ts)
  if (matched === null) return ''
  const [, y, mo, d, h, mi, s, ms] = matched
  const millis = (ms ?? '0').padEnd(3, '0')
  const offsetMinutes = -new Date().getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${millis}${offset}`
}

const lines: string[] = []
lines.push('<?xml version="1.0" encoding="UTF-8"?>')
lines.push('<log xes.version="1.0" xes.features="nested-attributes" xmlns="http://www.xes-standard.org/">')
lines.push('  <extension name="Concept" prefix="concept" uri="http://www.xes-standard.org/concept.xesext"/>')
lines.push('  <extension name="Time" prefix="time" uri="http://www.xes-standard.org/time.xesext"/>')
lines.push('  <extension name="Lifecycle" prefix="lifecycle" uri="http://www.xes-standard.org/lifecycle.xesext"/>')
lines.push('  <extension name="Organizational" prefix="org" uri="http://www.xes-standard.org/org.xesext"/>')
lines.push('  <global scope="trace"><string key="concept:name" value="__INVALID__"/></global>')
lines.push('  <global scope="event">')
lines.push('    <string key="concept:name" value="__INVALID__"/>')
lines.push('    <date key="time:timestamp" value="1970-01-01T00:00:00.000+00:00"/>')
lines.push('  </global>')

let exportedTraces = 0
let exportedEvents = 0
let skippedNoTime = 0

for (const item of result.cases) {
  // 无时间戳的事件无法参与时间维度校验；**跳过但计数**，由末尾披露（不静默丢弃）
  const usable = item.events.filter((event) => toIso(event.ts) !== '')
  skippedNoTime += item.events.length - usable.length
  if (usable.length === 0) continue

  exportedTraces += 1
  lines.push('  <trace>')
  lines.push(`    <string key="concept:name" value="${esc(item.caseId === '' ? '(no-case)' : item.caseId)}"/>`)
  // 业务对象作为 trace 级属性：为后续 OCEL（对象中心）建模留入口。
  // 前缀只写 `objectId`（不带 `case:`）——PM4Py 读入时会给 trace 属性自动加 `case:`，
  // 自己再加会变成 `case:case:objectId`（实测踩过）。
  const objectId = usable.find((event) => event.objectId !== '')?.objectId ?? ''
  if (objectId !== '') lines.push(`    <string key="objectId" value="${esc(objectId)}"/>`)

  for (const event of usable) {
    exportedEvents += 1
    lines.push('    <event>')
    lines.push(`      <string key="concept:name" value="${esc(normalizeLabel(event.label))}"/>`)
    lines.push(`      <date key="time:timestamp" value="${toIso(event.ts)}"/>`)
    lines.push(`      <string key="lifecycle:transition" value="${esc(event.phase)}"/>`)
    lines.push(`      <string key="org:resource" value="${esc(event.logger)}"/>`)
    // 自定义属性：保留可回跳的证据与成败，便于「判定结果反查日志行」
    lines.push(`      <string key="evidence:line" value="${event.evidence.line}"/>`)
    lines.push(`      <string key="evidence:source" value="${esc(event.evidence.source)}"/>`)
    if (event.durationMs !== null) lines.push(`      <float key="duration:ms" value="${event.durationMs}"/>`)
    if (event.ok !== null) lines.push(`      <boolean key="outcome:ok" value="${event.ok}"/>`)
    lines.push('    </event>')
  }
  lines.push('  </trace>')
}

lines.push('</log>')
writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')

process.stdout.write(`XES 已导出：${outPath}\n`)
process.stdout.write(`  trace ${exportedTraces} 个 ｜ event ${exportedEvents} 条 ｜ 解析率 ${(result.coverage.recordLines / (result.coverage.recordLines + result.coverage.orphanLines) * 100).toFixed(2)}%\n`)
if (skippedNoTime > 0) process.stdout.write(`  ⚠ ${skippedNoTime} 条事件因缺时间戳未导出（无法参与时间维度校验）\n`)

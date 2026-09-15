#!/usr/bin/env node
/**
 * 开发用摄取驱动 —— 在命令行上把一份日志跑成事实与覆盖度，用于人工核对与回归。
 *
 * 本文件干什么：读日志文件 → 调用 features/ingest → 打印覆盖度/案例/事件样本，可选导出 JSON。
 * 本文件不干什么：不含解析逻辑（逻辑在 features/），不改动被观测项目。
 *
 * 用法：tsx scripts/dev-ingest.ts <日志文件> [--json <输出路径>] [--case <caseId>]
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ingestLogText } from '../src/features/ingest'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'

/** 命令行参数。 */
const args = process.argv.slice(2)
const file = args[0]
if (file === undefined) {
  process.stderr.write('用法：tsx scripts/dev-ingest.ts <日志文件> [--json <输出路径>] [--case <caseId>]\n')
  process.exit(2)
}
const jsonIndex = args.indexOf('--json')
const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined
const caseIndex = args.indexOf('--case')
const wantedCase = caseIndex >= 0 ? args[caseIndex + 1] : undefined

const text = readFileSync(file, 'utf8')
const result = ingestLogText(text, { source: basename(file), pack: DSEDT_PACK })

/** 打印一行分隔标题。 */
function title(line: string): void {
  process.stdout.write(`\n${'─'.repeat(72)}\n${line}\n${'─'.repeat(72)}\n`)
}

title('① 格式选择（披露：为什么选它）')
for (const attempt of result.formatAttempts) {
  process.stdout.write(`  ${attempt.selected ? '✔' : ' '} ${attempt.format.padEnd(14)} 命中 ${attempt.hits} 行\n`)
}

title('② 覆盖度（AI 必须知道"我没看到什么"）')
const c = result.coverage
process.stdout.write(`  非空行 ${c.totalLines} ｜ 记录行 ${c.recordLines} ｜ 续行/堆栈 ${c.continuationLines} ｜ 漏网 ${c.orphanLines}\n`)
process.stdout.write(`  解析率 ${(c.ratio * 100).toFixed(2)}% ｜ 结论 = ${result.verdict}\n`)
for (const sample of c.orphanSamples.slice(0, 3)) {
  process.stdout.write(`    漏网样本 L${sample.line}: ${sample.text.slice(0, 90)}\n`)
}

title('③ 事实概览')
process.stdout.write(`  事件 ${result.eventCount} 条 ｜ 案例 ${result.caseCount} 个\n`)
for (const item of result.cases.slice(0, 5)) {
  process.stdout.write(
    `  案例 ${item.caseId.padEnd(40)} 事件 ${String(item.events.length).padStart(4)} ｜ 调用 ${String(item.callCount).padStart(3)} ｜ 异常 ${item.exceptionCount}\n`,
  )
}

title('④ 事件时序样本（每条带证据行号）')
const list = wantedCase === undefined
  ? result.events
  : (result.cases.find((item) => item.caseId === wantedCase)?.events ?? [])
if (list.length === 0) {
  process.stdout.write('  （无事件——请先检查②覆盖度结论，勿把空结果当作"系统无问题"）\n')
}
for (const event of list.slice(0, 25)) {
  const ok = event.ok === null ? ' ' : event.ok ? '✓' : '✗'
  const cost = event.durationMs === null ? '' : ` ${event.durationMs}ms`
  process.stdout.write(
    `  ${String(event.seq).padStart(4)} ${ok} [${event.phase.padEnd(11)}] ${event.label}${cost}  ← L${event.evidence.line}\n`,
  )
}

title('⑤ 告警（不阻断，但必须回显）')
if (result.warnings.length === 0) process.stdout.write('  （无）\n')
for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`)

if (jsonPath !== undefined) {
  writeFileSync(jsonPath, JSON.stringify(result, null, 2))
  process.stdout.write(`\n已导出 JSON：${jsonPath}\n`)
}

#!/usr/bin/env node
/**
 * 开发用判定驱动 —— 把一份日志跑成「事实 + 指纹 + 判定」，用于人工核对与演示。
 *
 * 本文件干什么：摄取日志 → 逐意图判定 → 打印判定与证据；可选做基线指纹对比与故障注入。
 * 本文件不干什么：不含判定逻辑（逻辑在 features/），不改动被观测项目。
 *
 * 用法：
 *   tsx scripts/dev-verdict.ts <日志文件> [--baseline <基线日志>] [--drop <标签子串>] [--json <输出>]
 *
 * `--drop` 是**故障注入**（明确标注，非真实改动）：删掉含该子串的事实，
 * 用于验证判定器能否抓到「漏做环节」。它不修改任何源码。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { buildFingerprint, compareFingerprints } from '../src/features/fingerprint'
import { ingestLogText } from '../src/features/ingest'
import { explainCoverage, judgeCase, type Verdict } from '../src/features/ruler'
import { DSEDT_INTENTS } from '../src/packs/dsedtIntent'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'

/** 命令行参数。 */
const args = process.argv.slice(2)
const file = args[0]
if (file === undefined) {
  process.stderr.write('用法：tsx scripts/dev-verdict.ts <日志文件> [--baseline <基线>] [--drop <子串>] [--json <输出>]\n')
  process.exit(2)
}
/** 取具名参数值。 */
function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const baselinePath = option('--baseline')
const dropToken = option('--drop')
const jsonPath = option('--json')

/** 打印分隔标题。 */
function title(line: string): void {
  process.stdout.write(`\n${'═'.repeat(76)}\n${line}\n${'═'.repeat(76)}\n`)
}

const source = basename(file)
const result = ingestLogText(readFileSync(file, 'utf8'), { source, pack: DSEDT_PACK })

title(`① 事实摄取 ｜ ${source}`)
process.stdout.write(`  格式=${result.formatUsed}（候选命中：${result.formatAttempts.map((a) => `${a.format}=${a.hits}`).join(', ')}）\n`)
process.stdout.write(`  ${explainCoverage(result.coverage)} ｜ 结论=${result.verdict} ｜ 事件=${result.eventCount}\n`)
for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`)

// 故障注入（明确标注，仅作用于内存中的事实序列）
let facts = result.cases[0]
if (dropToken !== undefined) {
  const before = facts.events.length
  const kept = facts.events.filter((event) => !event.label.includes(dropToken))
  facts = { ...facts, events: kept }
  title(`⚠ 故障注入（非真实改动）｜ 删除含「${dropToken}」的事实：${before} → ${kept.length} 条`)
}

title('② 标尺判定（逐意图）')
const verdicts: Verdict[] = []
for (const intent of DSEDT_INTENTS) {
  const verdict = judgeCase(intent, facts, result.verdict)
  verdicts.push(verdict)
  const mark = { pass: '✅', deviated: '🟡', failed: '❌', inconclusive: '⚪', 'out-of-scope': '⏭' }[verdict.status]
  process.stdout.write(`\n  ${mark} 【${intent.name}】 status=${verdict.status}\n`)
  process.stdout.write(`     ${verdict.basis}\n`)
  if (verdict.matched.length > 0) process.stdout.write(`     命中：${verdict.matched.join(' → ')}\n`)
  if (verdict.missing.length > 0) process.stdout.write(`     缺失：${verdict.missing.join(', ')}\n`)
  for (const finding of verdict.findings) {
    process.stdout.write(`     · [${finding.kind}/${finding.severity}] ${finding.message}\n`)
    for (const evidence of finding.evidence) {
      process.stdout.write(`         证据 ${evidence.source}:${evidence.line} → ${evidence.snippet.slice(0, 80)}\n`)
    }
  }
}

if (baselinePath !== undefined) {
  title('③ 行为指纹：与基线对比（结构层 vs 标签层）')
  const baseResult = ingestLogText(readFileSync(baselinePath, 'utf8'), { source: basename(baselinePath), pack: DSEDT_PACK })
  const delta = compareFingerprints(buildFingerprint(baseResult.cases[0].events), buildFingerprint(facts.events))
  process.stdout.write(`  基线事件=${baseResult.cases[0].events.length} ｜ 当前事件=${facts.events.length}\n`)
  process.stdout.write(`  差异类型=${delta.kind}\n  ${delta.summary}\n`)
  if (delta.firstDivergence >= 0) {
    process.stdout.write(`  首个分歧位置=${delta.firstDivergence + 1}\n`)
    if (delta.baseSample !== null) process.stdout.write(`    基线侧 L${delta.baseSample.line}: ${delta.baseSample.label.slice(0, 78)}\n`)
    if (delta.currentSample !== null) process.stdout.write(`    当前侧 L${delta.currentSample.line}: ${delta.currentSample.label.slice(0, 78)}\n`)
  }
}

if (jsonPath !== undefined) {
  writeFileSync(jsonPath, JSON.stringify({ source, coverage: result.coverage, verdict: result.verdict, verdicts }, null, 2))
  process.stdout.write(`\n判定已导出：${jsonPath}\n`)
}

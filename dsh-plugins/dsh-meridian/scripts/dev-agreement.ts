#!/usr/bin/env node
/**
 * 独立复核一致性度量 —— 把「我方判定」与「独立复核方判定」比对，算出可复核率。
 *
 * 本文件干什么：读两份判定 JSON，逐 (案例 × 意图) 比对状态与缺失项，输出一致率。
 * 本文件不干什么：不产生判定（判定在 features/ruler），不调用模型（复核方由外部产生）。
 *
 * 用法：tsx scripts/dev-agreement.ts <我方判定目录或逗号分隔文件> <复核方 JSON>
 * 我方判定文件由 `scripts/dev-verdict.ts --json` 产出（结构含 verdicts[]）。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { readFileSync } from 'node:fs'

const [minePaths, reviewerPath] = process.argv.slice(2)
if (minePaths === undefined || reviewerPath === undefined) {
  process.stderr.write('用法：tsx scripts/dev-agreement.ts <我方判定 json（逗号分隔）> <复核方 json>\n')
  process.exit(2)
}

interface ReviewerJudgment {
  case: string
  intent: string
  status: string
  missing: string[]
}
interface MineVerdict {
  intent: string
  status: string
  missing: string[]
}
interface MineFile {
  source: string
  verdicts: MineVerdict[]
}

const reviewers = (JSON.parse(readFileSync(reviewerPath, 'utf8')) as { judgments: ReviewerJudgment[] }).judgments
const mineFiles = minePaths.split(',').map((path) => JSON.parse(readFileSync(path, 'utf8')) as MineFile)

let total = 0
let statusAgree = 0
let missingAgree = 0
const rows: string[] = []
for (const file of mineFiles) {
  for (const verdict of file.verdicts) {
    const reviewer = reviewers.find((item) => item.intent === verdict.intent && item.case === file.source)
    if (reviewer === undefined) continue
    total += 1
    const sameStatus = reviewer.status === verdict.status
    const sameMissing =
      reviewer.missing.length === verdict.missing.length && reviewer.missing.every((m) => verdict.missing.includes(m))
    if (sameStatus) statusAgree += 1
    if (sameMissing) missingAgree += 1
    rows.push(
      `  ${sameStatus && sameMissing ? '✅' : '❌'} ${file.source} × ${verdict.intent}\n` +
        `      我方=${verdict.status}${verdict.missing.length > 0 ? ` 缺失=[${verdict.missing.join(', ')}]` : ''}\n` +
        `      复核=${reviewer.status}${reviewer.missing.length > 0 ? ` 缺失=[${reviewer.missing.join(', ')}]` : ''}`,
    )
  }
}

process.stdout.write(`\n${'═'.repeat(76)}\n独立复核一致性\n${'═'.repeat(76)}\n`)
process.stdout.write(rows.join('\n') + '\n')
const rate = total === 0 ? 0 : (statusAgree / total) * 100
process.stdout.write(`\n  比对条目 ${total} ｜ 状态一致 ${statusAgree} ｜ 缺失项一致 ${missingAgree}\n`)
process.stdout.write(`  状态一致率 = ${rate.toFixed(1)}%（目标 ≥ 90%）\n`)
process.exit(rate >= 90 ? 0 : 1)

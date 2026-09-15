#!/usr/bin/env node
/**
 * 独立复核样本生成器 —— 产出「证据包」（给复核方）与「我方判定」（给自己比对）。
 *
 * 本文件干什么：跨两个实例、多个案例与多条意图，跑出足量判定样本；
 * 分别写出不含结论的证据包（review-bundle.json）与我方判定（mine.json）。
 * 本文件不干什么：不调用模型（复核方由外部产生），不改被观测项目。
 *
 * 用法：tsx scripts/dev-review-bundle.ts <输出目录>
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ingestLogText } from '../src/features/ingest'
import { judgeCase, type Intent } from '../src/features/ruler'
import { DSEDT_INTENTS } from '../src/packs/dsedtIntent'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'
import { IHM2_INTENTS } from '../src/packs/ihm2Intent'
import { IHM2_PACK } from '../src/packs/ihm2Laravel'

/** 输出目录。 */
const outDir = process.argv[2] ?? '/tmp/meridian-raw'
/** DSEDT 逐测试案例目录（2026-09-15 真实测试运行产物按测试拆分）。 */
const DSEDT_CASE_DIR = '/tmp/meridian-raw/run2'
/** IHM2 真实日志。 */
const IHM2_LOG = `${process.env.HOME}/ihm2_workspace/src/ihm-backend/storage/logs/11ea28bb7ffd-laravel-2026-09-15.log`

/** 复核包里的单个案例。 */
interface BundleCase {
  /** 案例标签（复核方与比对都以此为准）。 */
  case: string
  /** 稳定来源描述（不复核判定，仅供追溯）。 */
  source: string
  /** 覆盖度结论（复核方据此判断事实是否可信）。 */
  coverageVerdict: string
  /** 事实序列（已脱敏、已截断）。 */
  facts: Array<{ seq: number; phase: string; level: string; label: string; line: number }>
}

/** 我方判定条目。 */
interface MyJudgment {
  case: string
  intent: string
  status: string
  missing: string[]
  findings: string[]
}

const bundleCases: BundleCase[] = []
const myJudgments: MyJudgment[] = []

/** 把一个案例 × 一组意图跑一遍，同时产出证据与判定。 */
function collect(
  caseLabel: string,
  source: string,
  subjects: ReturnType<typeof ingestLogText>['cases'],
  intents: Intent[],
  coverageVerdict: string,
): void {
  for (const facts of subjects) {
    bundleCases.push({
      case: caseLabel,
      source,
      coverageVerdict,
      facts: facts.events.map((event) => ({
        seq: event.seq,
        phase: event.phase,
        level: event.level,
        label: event.label,
        line: event.evidence.line,
      })),
    })
    for (const intent of intents) {
      const verdict = judgeCase(intent, facts, coverageVerdict as 'ok' | 'degraded' | 'failed')
      myJudgments.push({
        case: caseLabel,
        intent: intent.name,
        status: verdict.status,
        missing: verdict.missing,
        findings: verdict.findings.map((item) => item.kind),
      })
    }
  }
}

// ① DSEDT：逐测试案例（技术案例视角）
const caseFiles = readdirSync(DSEDT_CASE_DIR).filter((name) => name.endsWith('.log'))
for (const file of caseFiles) {
  const path = join(DSEDT_CASE_DIR, file)
  const result = ingestLogText(readFileSync(path, 'utf8'), { source: basename(file), pack: DSEDT_PACK })
  const label = `dsedt:${basename(file).replace(/^com\.dsedt\.verification\./, '').replace(/\.log$/, '')}`
  collect(label, path, result.cases, DSEDT_INTENTS, result.verdict)
}

// ①′ 对照案例：核验确认全流程 / 缺失落库步骤的版本（检验检出能力）
for (const [label, path] of [
  ['dsedt:ConfirmVerify-full', '/tmp/meridian-raw/case-A.log'],
  ['dsedt:ConfirmVerify-missing-persist', '/tmp/meridian-raw/case-B.log'],
] as const) {
  const result = ingestLogText(readFileSync(path, 'utf8'), { source: basename(path), pack: DSEDT_PACK })
  collect(label, path, result.cases, DSEDT_INTENTS, result.verdict)
}

// ② IHM2：按业务对象（单据视角），取事件最多的前 6 张单据
const ihm2 = ingestLogText(readFileSync(IHM2_LOG, 'utf8'), { source: basename(IHM2_LOG), pack: IHM2_PACK })
for (const objectCase of ihm2.objectCases.slice(0, 6)) {
  collect(`ihm2:${objectCase.caseId}`, IHM2_LOG, [objectCase], IHM2_INTENTS, ihm2.verdict)
}

// ③ 写出：证据包（**不含任何判定**）与我方判定
const intents = [...DSEDT_INTENTS, ...IHM2_INTENTS].map((intent) => ({
  name: intent.name,
  appliesWhen: intent.appliesWhen ?? null,
  expect: intent.expect,
  expectEnd: intent.expectEnd ?? null,
  allow: intent.allow ?? [],
}))
writeFileSync(join(outDir, 'review-bundle.json'), JSON.stringify({ intents, cases: bundleCases }, null, 1))
writeFileSync(join(outDir, 'mine.json'), JSON.stringify({ judgments: myJudgments }, null, 1))

const dist: Record<string, number> = {}
for (const item of myJudgments) dist[item.status] = (dist[item.status] ?? 0) + 1
process.stdout.write(`证据包案例 ${bundleCases.length} 个 ｜ 意图 ${intents.length} 条 ｜ 判定样本 ${myJudgments.length} 条\n`)
process.stdout.write(`我方判定分布：${JSON.stringify(dist)}\n`)
process.stdout.write(`已写出：${join(outDir, 'review-bundle.json')}（无结论）与 ${join(outDir, 'mine.json')}\n`)

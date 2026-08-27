/**
 * 报告引擎与质量门禁。
 *
 * 聚合各工具的产物（`.code-review/` 下的 `last-*.json`），与上一轮基线
 * 对比性能，评估质量门禁，并渲染 `report-<round>.md` + `report-latest.md`。
 * 结构化裁决（`pass`）是审查闭环预设的行动依据——循环持续修复直到
 * `pass` 或达到轮次上限。
 * @module @deepseek-ai/dsh-code-review
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BenchResult, Finding, GateCheck, GateResult, GateThresholds, PerfDelta, ProfileResult, TestResult } from '../features/types'

/** {@link generateReport} 的选项。 */
export interface ReportOptions {
  /** 被审查的项目根目录（绝对或相对；会解析）。 */
  project: string
  /** 项目内的产物目录名。默认 `.code-review`。 */
  artifactsDir?: string
  /** AI 附加的人类摘要（优雅性备注、计划等）。 */
  summary?: string
  /** AI 评定的优雅性分数 0-100。 */
  eleganceScore?: number
  /** 质量门禁阈值覆盖。 */
  thresholds?: Partial<GateThresholds>
}

/** 一次报告运行的结果。 */
export interface ReportResult {
  round: number
  pass: boolean
  reportPath: string
  findingsCount: number
  gate: GateResult
  perfDeltas: PerfDelta[]
  bench?: BenchResult
  test?: TestResult
}

const DEFAULT_THRESHOLDS: GateThresholds = {
  testPassRate: 1,
  coverageThreshold: 0,
  perfRegressThresholdPct: 10,
  eleganceThreshold: 0,
}

/** 读取 last-* 产物；缺失时返回 undefined。 */
export function readArtifact<T>(projectDir: string, artifactsDir: string, name: string): T | undefined {
  const path = join(projectDir, artifactsDir, name)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * 生成本轮报告：聚合产物、与基线对比、评估门禁、写产物 + Markdown。
 * @param options - 报告选项。
 * @returns 结构化裁决。
 */
export function generateReport(options: ReportOptions): ReportResult {
  const projectDir = resolve(options.project)
  const artifactsDir = options.artifactsDir ?? '.code-review'
  const dir = join(projectDir, artifactsDir)
  mkdirSync(dir, { recursive: true })

  const findings = readArtifact<Finding[]>(projectDir, artifactsDir, 'last-lint.json') ?? []
  const format = readArtifact<{ clean: boolean; dirtyFiles: string[] }>(projectDir, artifactsDir, 'last-format.json')
  const bench = readArtifact<BenchResult>(projectDir, artifactsDir, 'last-bench.json')
  const profile = readArtifact<ProfileResult>(projectDir, artifactsDir, 'last-profile.json')
  const test = readArtifact<TestResult>(projectDir, artifactsDir, 'last-test.json')
  const baseline = readArtifact<Record<string, number>>(projectDir, artifactsDir, 'baseline.json')

  const thresholds: GateThresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds }
  const state = readArtifact<{ round: number }>(projectDir, artifactsDir, 'state.json')
  const round = (state?.round ?? 0) + 1

  const checks: GateCheck[] = []
  // 1. 静态发现：无 P0/P1 遗留。
  const blockers = findings.filter(finding => finding.severity === 'P0' || finding.severity === 'P1')
  checks.push({
    name: '静态检查',
    pass: blockers.length === 0,
    detail: blockers.length === 0
      ? `无 P0/P1 问题（共 ${findings.length} 条，P2/P3 为建议级）`
      : `存在 ${blockers.length} 条阻塞问题（P0/P1）：${blockers.slice(0, 3).map(f => `${f.file}:${f.line ?? '?'} ${f.rule ?? f.message.slice(0, 40)}`).join('；')}`,
  })
  // 2. 格式化。
  if (format) {
    checks.push({
      name: '格式化',
      pass: format.clean,
      detail: format.clean ? '格式合规' : `${format.dirtyFiles.length} 个文件需要格式化：${format.dirtyFiles.slice(0, 5).join(', ')}${format.dirtyFiles.length > 5 ? ' …' : ''}`,
    })
  } else {
    checks.push({ name: '格式化', pass: true, detail: '未运行或未安装 formatter，跳过' })
  }
  // 3. 测试。
  if (test) {
    const rateOk = test.total > 0 && test.failed === 0 && test.passed / test.total >= thresholds.testPassRate
    checks.push({
      name: '测试',
      pass: rateOk,
      detail: `${test.passed}/${test.total} 通过，${test.failed} 失败，${test.skipped} 跳过${test.coveragePct !== undefined ? `，覆盖率 ${test.coveragePct}%` : ''}${test.error ? `（${test.error}）` : ''}`,
    })
    if (thresholds.coverageThreshold > 0) {
      const covOk = test.coveragePct !== undefined && test.coveragePct >= thresholds.coverageThreshold
      checks.push({
        name: '覆盖率',
        pass: covOk,
        detail: covOk
          ? `${test.coveragePct}% ≥ ${thresholds.coverageThreshold}%`
          : `${test.coveragePct ?? '未知'}% < ${thresholds.coverageThreshold}%`,
      })
    }
  } else {
    checks.push({ name: '测试', pass: false, detail: '未运行测试' })
  }
  // 4. 相对基线的性能。
  const perfDeltas: PerfDelta[] = []
  if (bench) {
    const prevP50 = baseline?.[bench.command]
    if (prevP50 !== undefined) {
      const deltaPct = Math.round(((bench.p50Ms - prevP50) / prevP50) * 1000) / 10
      perfDeltas.push({ command: bench.command, prevP50Ms: prevP50, nowP50Ms: bench.p50Ms, deltaPct })
      checks.push({
        name: '性能回归',
        pass: deltaPct <= thresholds.perfRegressThresholdPct,
        detail: `${bench.command}: p50 ${prevP50}ms → ${bench.p50Ms}ms（${deltaPct >= 0 ? '+' : ''}${deltaPct}%），阈值 +${thresholds.perfRegressThresholdPct}%`,
      })
    } else {
      checks.push({ name: '性能基线', pass: true, detail: `${bench.command}: 首轮建立基线 p50=${bench.p50Ms}ms（无历史对比）` })
    }
  }
  // 5. 优雅性（建议级）。
  if (options.eleganceScore !== undefined && thresholds.eleganceThreshold > 0) {
    checks.push({
      name: '优雅性',
      pass: options.eleganceScore >= thresholds.eleganceThreshold,
      detail: `AI 评审 ${options.eleganceScore}/100（阈值 ${thresholds.eleganceThreshold}）`,
    })
  }

  const gate: GateResult = { pass: checks.every(check => check.pass), checks }

  // 持久化轮次状态：基线合并、state、报告。
  const mergedBaseline = { ...baseline }
  if (bench) mergedBaseline[bench.command] = bench.p50Ms
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify(mergedBaseline, null, 2))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ round }, null, 2))

  const markdown = renderMarkdown({
    round,
    project: projectDir,
    findings,
    ...(format !== undefined ? { format } : {}),
    ...(bench !== undefined ? { bench } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(test !== undefined ? { test } : {}),
    perfDeltas,
    gate,
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
    ...(options.eleganceScore !== undefined ? { eleganceScore: options.eleganceScore } : {}),
  })
  writeFileSync(join(dir, `report-${round}.md`), markdown)
  writeFileSync(join(dir, 'report-latest.md'), markdown)

  return {
    round,
    pass: gate.pass,
    reportPath: join(dir, `report-${round}.md`),
    findingsCount: findings.length,
    gate,
    perfDeltas,
    ...(bench !== undefined ? { bench } : {}),
    ...(test !== undefined ? { test } : {}),
  }
}

interface RenderInput {
  round: number
  project: string
  findings: Finding[]
  format?: { clean: boolean; dirtyFiles: string[] }
  bench?: BenchResult
  profile?: ProfileResult
  test?: TestResult
  perfDeltas: PerfDelta[]
  gate: GateResult
  summary?: string
  eleganceScore?: number
}

/** 渲染 Markdown 诊断报告。 */
export function renderMarkdown(input: RenderInput): string {
  const lines: string[] = []
  lines.push(`# 代码审查诊断报告 · 第 ${input.round} 轮`)
  lines.push('')
  lines.push(`- **项目**：\`${input.project}\``)
  lines.push(`- **结论**：${input.gate.pass ? '✅ **通过**' : '❌ **未通过**'}`)
  lines.push(`- **生成时间**：${new Date().toISOString()}`)
  if (input.summary) {
    lines.push('')
    lines.push('## 摘要')
    lines.push('')
    lines.push(input.summary)
  }
  if (input.eleganceScore !== undefined) {
    lines.push('')
    lines.push(`**AI 优雅性评分**：${input.eleganceScore}/100`)
  }
  lines.push('')
  lines.push('## Quality Gate')
  lines.push('')
  lines.push('| 检查项 | 结果 | 详情 |')
  lines.push('| --- | --- | --- |')
  for (const check of input.gate.checks) {
    lines.push(`| ${check.name} | ${check.pass ? '✅' : '❌'} | ${check.detail} |`)
  }
  lines.push('')
  lines.push('## 静态检查')
  lines.push('')
  if (input.findings.length === 0) {
    lines.push('无问题。')
  } else {
    const bySeverity = (severity: string) => input.findings.filter(f => f.severity === severity)
    for (const severity of ['P0', 'P1', 'P2', 'P3'] as const) {
      const list = bySeverity(severity)
      if (list.length === 0) continue
      lines.push(`### ${severity}（${list.length}）`)
      lines.push('')
      lines.push('| 文件 | 行 | 规则 | 消息 |')
      lines.push('| --- | --- | --- | --- |')
      for (const f of list.slice(0, 30)) {
        lines.push(`| \`${f.file}\` | ${f.line ?? '-'} | ${f.rule ?? '-'} | ${f.message.replace(/\|/g, '\\|').slice(0, 120)} |`)
      }
      if (list.length > 30) lines.push(`| … 其余 ${list.length - 30} 条略 | | | |`)
      lines.push('')
    }
  }
  if (input.format) {
    lines.push('## 格式化')
    lines.push('')
    lines.push(input.format.clean
      ? '格式合规。'
      : `需要格式化（${input.format.dirtyFiles.length} 个文件）：\`${input.format.dirtyFiles.join('、')}\``)
    lines.push('')
  }
  if (input.bench) {
    const b = input.bench
    lines.push('## 性能基准（程序级）')
    lines.push('')
    lines.push(`命令：\`${b.command}\`（${b.iterations} 次，排除冷启动）`)
    lines.push('')
    lines.push('| 指标 | 值 |')
    lines.push('| --- | --- |')
    lines.push(`| p50 | ${b.p50Ms} ms |`)
    lines.push(`| p90 | ${b.p90Ms} ms |`)
    lines.push(`| 均值 | ${b.meanMs} ms |`)
    lines.push(`| 最快/最慢 | ${b.minMs} / ${b.maxMs} ms |`)
    if (b.peakRssMb !== undefined) lines.push(`| 内存峰值(RSS) | ${b.peakRssMb} MB |`)
    if (b.error) lines.push(`| 错误 | ${b.error} |`)
    lines.push('')
    if (input.perfDeltas.length > 0) {
      lines.push('| 对比上轮 | 上轮 p50 | 本轮 p50 | 变化 |')
      lines.push('| --- | --- | --- | --- |')
      for (const delta of input.perfDeltas) {
        lines.push(`| \`${delta.command}\` | ${delta.prevP50Ms} ms | ${delta.nowP50Ms} ms | ${delta.deltaPct! >= 0 ? '+' : ''}${delta.deltaPct}% |`)
      }
      lines.push('')
    }
  }
  if (input.profile && input.profile.entries.length > 0) {
    const p = input.profile
    lines.push('## 性能热点（函数级剖析）')
    lines.push('')
    lines.push(`引擎：\`${p.engine}\`，总自耗时 ${Math.round(p.totalMs)} ms`)
    lines.push('')
    lines.push('| # | 函数 | 位置 | 自耗时 | 占比 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const [index, entry] of p.entries.entries()) {
      const location = entry.url === '(native)' ? 'native' : `${entry.url}:${entry.line}`
      lines.push(`| ${index + 1} | \`${entry.functionName}\` | ${location} | ${Math.round(entry.selfMs)} ms | ${entry.selfPct}% |`)
    }
    lines.push('')
    if (p.note) {
      lines.push(`> ${p.note}`)
      lines.push('')
    }
  } else if (input.profile?.note) {
    lines.push('## 性能热点（函数级剖析）')
    lines.push('')
    lines.push(`> ${input.profile.note}`)
    lines.push('')
  }
  if (input.test) {
    const t = input.test
    lines.push('## 测试')
    lines.push('')
    lines.push(`工具：\`${t.tool}\` · ${t.passed}/${t.total} 通过，${t.failed} 失败，${t.skipped} 跳过，耗时 ${t.durationMs}ms${t.coveragePct !== undefined ? `，覆盖率 ${t.coveragePct}%` : ''}`)
    if (t.error) {
      lines.push('')
      lines.push(`> ${t.error.slice(0, 500)}`)
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('生成于 DeepSeek Harness `dsh-code-review`。修复后重新运行审查工具并再次生成报告，直到 Quality Gate 全部通过。')
  return lines.join('\n')
}

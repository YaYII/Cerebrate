/**
 * 六个 code_review_* 工具的业务编排层——顶层执行函数，独立可测。
 *
 * 每个工具的 execute 都是顶层导出函数（可注入真实/假项目目录直接单元
 * 测试），buildReviewTools 只做装配引用。功能能力（子进程运行、输出解析、
 * 基准、报告引擎）在 features/ 与 business/report.ts，本文件只组合它们。
 *
 * @module @deepseek-ai/dsh-code-review
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { detectToolchains, probeToolchain, resolveBin } from '../features/languages'
import { runLint, runFormat } from '../features/lint'
import { runBench, runProfile, saveArtifact } from '../features/bench'
import { runTests } from '../features/test'
import { runCommand } from '../features/runner'
import type { Finding } from '../features/types'
import { generateReport, readArtifact } from './report'

/** 插件配置（工具执行所需的最小形状）。 */
export interface ReviewToolConfig {
  artifactsDir: string
  benchIterations: number
  testTimeoutMs: number
}

/** JSON 安全的发现列表视图（有界、模型友好）。 */
function summarizeFindings(findings: Finding[], limit = 30): JsonValue {
  return findings.slice(0, limit).map(f => ({
    severity: f.severity,
    file: f.file,
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.rule !== undefined ? { rule: f.rule } : {}),
    message: f.message.slice(0, 200),
  }))
}

/** 把项目参数解析为绝对路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/**
 * code_review_lint 顶层执行函数：运行 linter（JS/TS 默认 eslint，存在
 * tsconfig.json 时额外 tsc --noEmit），归一化问题清单并落盘。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project（被审查项目目录）。
 * @returns { status, data: { total, blockers, findings, notes?, artifact } }。
 */
export async function executeLint(
  config: ReviewToolConfig,
  args: { project?: string },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const chains = detectToolchains(projectDir)
  if (chains.length === 0) {
    return { status: 'error', message: `未在 ${projectDir} 识别到支持的语言（找 package.json / pom.xml / requirements.txt / composer.json）` }
  }
  const findings: Finding[] = []
  const notes: string[] = []
  for (const chain of chains) {
    const probe = probeToolchain(projectDir, chain)
    if (!probe.lint) {
      notes.push(`${chain.language}: eslint 未安装（缺 node_modules/.bin/eslint），跳过`)
      continue
    }
    const lint = await runLint(projectDir, chain)
    findings.push(...lint.findings)
    if (lint.error) notes.push(`${chain.language}: ${lint.error}`)
    if (chain.language === 'js-ts' && existsSync(join(projectDir, 'tsconfig.json'))) {
      const tsc = await runLint(projectDir, chain, 'tsc')
      findings.push(...tsc.findings)
    }
  }
  saveArtifact(projectDir, config.artifactsDir, 'last-lint.json', findings)
  const blockers = findings.filter(f => f.severity === 'P0' || f.severity === 'P1').length
  return {
    status: 'ok',
    data: {
      total: findings.length,
      blockers,
      findings: summarizeFindings(findings),
      ...(notes.length > 0 ? { notes } : {}),
      artifact: join(projectDir, config.artifactsDir, 'last-lint.json'),
    },
  }
}

/**
 * code_review_format 顶层执行函数：格式检查（fix=true 时先 --write/--fix
 * 再复查），落盘 dirty-file 清单。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project / fix（是否直接修复）。
 * @returns { status, data: { results, notes?, artifact } }。
 */
export async function executeFormat(
  config: ReviewToolConfig,
  args: { project?: string; fix?: boolean },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const chains = detectToolchains(projectDir)
  if (chains.length === 0) {
    return { status: 'error', message: `未在 ${projectDir} 识别到支持的语言` }
  }
  const results: Array<{ language: string; clean: boolean; dirtyFiles: string[]; error?: string }> = []
  const notes: string[] = []
  for (const chain of chains) {
    const probe = probeToolchain(projectDir, chain)
    if (!probe.format) {
      const message = `${chain.language}: ${chain.format?.bin ?? 'formatter'} 未安装（缺 node_modules/.bin/），跳过格式检查`
      notes.push(message)
      results.push({ language: chain.language, clean: true, dirtyFiles: [], error: message })
      continue
    }
    if (args.fix && chain.language === 'js-ts') {
      await runFormatFix(projectDir)
    }
    const format = await runFormat(projectDir, chain)
    results.push({
      language: chain.language,
      clean: format.clean,
      dirtyFiles: format.dirtyFiles,
      ...(format.error !== undefined ? { error: format.error } : {}),
    })
  }
  saveArtifact(projectDir, config.artifactsDir, 'last-format.json', results[0] ?? { clean: true, dirtyFiles: [] })
  return { status: 'ok', data: { results, ...(notes.length > 0 ? { notes } : {}), artifact: join(projectDir, config.artifactsDir, 'last-format.json') } }
}

/**
 * code_review_bench 顶层执行函数：程序级基准（N 次、排除冷启动、RSS），
 * 与上轮基线对比报告回归。
 * @param config - 插件配置（迭代次数/产物目录）。
 * @param args - 工具入参：project / command / iterations / timeoutMs。
 * @returns { status, data: { p50/p90/mean/min/max/peakRssMb/prevRoundP50Ms?/deltaPct?/error?/artifact } }。
 */
export async function executeBench(
  config: ReviewToolConfig,
  args: { project?: string; command: string; iterations?: number; timeoutMs?: number },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const bench = await runBench({
    command: args.command,
    cwd: projectDir,
    iterations: args.iterations ?? config.benchIterations,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  })
  saveArtifact(projectDir, config.artifactsDir, 'last-bench.json', bench)
  const baseline = readArtifact<Record<string, number>>(projectDir, config.artifactsDir, 'baseline.json')
  const prevP50 = baseline?.[args.command]
  return {
    status: 'ok',
    data: {
      command: bench.command,
      p50Ms: bench.p50Ms,
      p90Ms: bench.p90Ms,
      meanMs: bench.meanMs,
      minMs: bench.minMs,
      maxMs: bench.maxMs,
      ...(bench.peakRssMb !== undefined ? { peakRssMb: bench.peakRssMb } : {}),
      ...(prevP50 !== undefined ? { prevRoundP50Ms: prevP50, deltaPct: Math.round(((bench.p50Ms - prevP50) / prevP50) * 1000) / 10 } : { note: '首轮，基线将在报告轮建立' }),
      ...(bench.error !== undefined ? { error: bench.error } : {}),
      artifact: join(projectDir, config.artifactsDir, 'last-bench.json'),
    },
  }
}

/**
 * code_review_profile 顶层执行函数：函数级剖析（v8 --cpu-prof / cProfile），
 * 解析热点 Top10 并落盘。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project / command / timeoutMs。
 * @returns { status, data: { engine, totalMs, entries, note?, artifact } }。
 */
export async function executeProfile(
  config: ReviewToolConfig,
  args: { project?: string; command: string; timeoutMs?: number },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const chains = detectToolchains(projectDir)
  if (chains.length === 0) {
    return { status: 'error', message: `未在 ${projectDir} 识别到支持的语言` }
  }
  const chain = chains[0]!
  const profile = await runProfile({ command: args.command, cwd: projectDir, toolchain: chain, ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) })
  saveArtifact(projectDir, config.artifactsDir, 'last-profile.json', profile)
  return {
    status: 'ok',
    data: {
      engine: profile.engine,
      totalMs: Math.round(profile.totalMs),
      entries: profile.entries.map(e => ({ functionName: e.functionName, location: `${e.url}:${e.line}`, selfMs: Math.round(e.selfMs), selfPct: e.selfPct })),
      ...(profile.note !== undefined ? { note: profile.note } : {}),
      artifact: join(projectDir, config.artifactsDir, 'last-profile.json'),
    },
  }
}

/**
 * code_review_test 顶层执行函数：运行测试套件（vitest/pytest/mvn/phpunit），
 * 提取通过/失败/覆盖率并落盘。
 * @param config - 插件配置（测试超时/产物目录）。
 * @param args - 工具入参：project / coverage / extraArgs。
 * @returns { status, data: { tool, total, passed, failed, skipped, durationMs, coveragePct?, error?, artifact } }。
 */
export async function executeTest(
  config: ReviewToolConfig,
  args: { project?: string; coverage?: boolean; extraArgs?: string[] },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const chains = detectToolchains(projectDir)
  if (chains.length === 0) {
    return { status: 'error', message: `未在 ${projectDir} 识别到支持的语言` }
  }
  const chain = chains[0]!
  const probe = probeToolchain(projectDir, chain)
  if (!probe.test) {
    const message = `${chain.language}: ${chain.test?.bin ?? 'test runner'} 未安装（缺 node_modules/.bin/），跳过测试`
    const skipped = { tool: chain.test?.bin ?? 'unknown', total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, error: message }
    saveArtifact(projectDir, config.artifactsDir, 'last-test.json', skipped)
    return { status: 'ok', data: { ...skipped, artifact: join(projectDir, config.artifactsDir, 'last-test.json') } }
  }
  const extra = [...(args.extraArgs ?? [])]
  if (args.coverage) {
    extra.push(chain.language === 'python' ? '--cov' : '--coverage')
  }
  const test = await runTests(projectDir, chain, { cwd: projectDir, timeoutMs: config.testTimeoutMs, extraArgs: extra })
  saveArtifact(projectDir, config.artifactsDir, 'last-test.json', test)
  return {
    status: 'ok',
    data: {
      tool: test.tool,
      total: test.total,
      passed: test.passed,
      failed: test.failed,
      skipped: test.skipped,
      durationMs: test.durationMs,
      ...(test.coveragePct !== undefined ? { coveragePct: test.coveragePct } : {}),
      ...(test.error !== undefined ? { error: test.error } : {}),
      artifact: join(projectDir, config.artifactsDir, 'last-test.json'),
    },
  }
}

/**
 * code_review_report 顶层执行函数：聚合产物、对比基线、评估门禁、生成
 * Markdown 报告，返回结构化裁决。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project / summary / eleganceScore / 各阈值。
 * @returns { status, data: { round, pass, findingsCount, gate, perfDeltas, reportPath, nextStep } }。
 */
export async function executeReport(
  config: ReviewToolConfig,
  args: { project?: string; summary?: string; eleganceScore?: number; testPassRate?: number; coverageThreshold?: number; perfRegressThresholdPct?: number; eleganceThreshold?: number },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const result = generateReport({
    project: projectDir,
    artifactsDir: config.artifactsDir,
    ...(args.summary !== undefined ? { summary: args.summary } : {}),
    ...(args.eleganceScore !== undefined ? { eleganceScore: args.eleganceScore } : {}),
    thresholds: {
      ...(args.testPassRate !== undefined ? { testPassRate: args.testPassRate } : {}),
      ...(args.coverageThreshold !== undefined ? { coverageThreshold: args.coverageThreshold } : {}),
      ...(args.perfRegressThresholdPct !== undefined ? { perfRegressThresholdPct: args.perfRegressThresholdPct } : {}),
      ...(args.eleganceThreshold !== undefined ? { eleganceThreshold: args.eleganceThreshold } : {}),
    },
  })
  return {
    status: 'ok',
    data: {
      round: result.round,
      pass: result.pass,
      findingsCount: result.findingsCount,
      gate: {
        pass: result.gate.pass,
        checks: result.gate.checks.map(check => ({ name: check.name, pass: check.pass, detail: check.detail })),
      },
      perfDeltas: result.perfDeltas.map(delta => ({
        command: delta.command,
        ...(delta.prevP50Ms !== undefined ? { prevP50Ms: delta.prevP50Ms } : {}),
        ...(delta.nowP50Ms !== undefined ? { nowP50Ms: delta.nowP50Ms } : {}),
        ...(delta.deltaPct !== undefined ? { deltaPct: delta.deltaPct } : {}),
      })),
      reportPath: result.reportPath,
      nextStep: result.pass
        ? '审查通过 ✅'
        : `未通过：按报告修复（P0/P1、格式、测试、性能热点），然后重新运行 code_review_lint/format/test/bench/profile 并再次 code_review_report（第 ${result.round + 1} 轮）`,
    },
  }
}

/** 在 JS/TS 项目里应用 prettier --write + eslint --fix。 */
async function runFormatFix(projectDir: string): Promise<void> {
  for (const [bin, args] of [
    ['prettier', ['--write', '.']],
    ['eslint', ['--fix', '.', '--no-warn-ignored']],
  ] as const) {
    const resolved = resolveBin(projectDir, bin)
    if (resolved !== bin) {
      await runCommand(resolved, [...args], { cwd: projectDir, timeoutMs: 120_000 })
    }
  }
}

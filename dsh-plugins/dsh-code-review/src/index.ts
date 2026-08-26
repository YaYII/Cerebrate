/**
 * AI code-review assistant for DeepSeek Harness.
 *
 * Six deterministic `code_review_*` tools drive the review pipeline:
 *   1. `code_review_lint`    — static lint (eslint + tsc for JS/TS; toolchain
 *                              registry for Java/Python/PHP) → normalized findings.
 *   2. `code_review_format`  — formatter check (or fix) → dirty-file list.
 *   3. `code_review_bench`   — program-level benchmark: N runs, p50/p90/mean,
 *                              peak RSS — "how much does this program cost to run".
 *   4. `code_review_profile` — function-level CPU profile (v8 --cpu-prof for
 *                              JS/TS, cProfile for Python) → top hot functions,
 *                              the direct evidence for performance bugs.
 *   5. `code_review_test`    — test suite run + coverage extraction.
 *   6. `code_review_report`  — aggregate artifacts, compare against the
 *                              previous baseline, evaluate the quality gate and
 *                              render `report-<round>.md` + `report-latest.md`.
 *
 * Everything lands under `<project>/.code-review/` (artifacts, baseline, round
 * state), so the fix → re-review loop is resumable and every round is
 * comparable. A plugin-sourced guidance message tells the model how to run the
 * loop until the gate passes.
 *
 * @module @deepseek-ai/dsh-code-review
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { detectToolchains, probeToolchain, resolveBin } from './languages'
import { runLint, runFormat } from './lint'
import { runBench, runProfile, saveArtifact } from './bench'
import { runTests } from './test'
import { generateReport, readArtifact } from './report'
import { runCommand } from './runner'
import type { Finding } from './types'

/** Plugin identifier, used as the cordis entry name and injection source tag. */
export const name = 'dsh-code-review'
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Artifacts directory name inside the reviewed project. */
  artifactsDir: string
  /** Whether the review-loop guidance message is injected on the first step. */
  injectGuidance: boolean
  /** Default benchmark iterations. */
  benchIterations: number
  /** Default test timeout, ms. */
  testTimeoutMs: number
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  artifactsDir: z.string().default('.code-review'),
  injectGuidance: z.boolean().default(true),
  benchIterations: z.number().default(5),
  testTimeoutMs: z.number().default(300_000),
})

/** Review-loop guidance folded into the first agent step. */
const REVIEW_GUIDANCE = [
  '【代码审查】本会话具备 dsh-code-review 全套审查工具（code_review_lint/format/bench/profile/test/report），用于对 AI 写完的代码做自动审查、性能诊断与修复闭环。',
  '审查流程（按序执行）：先 code_review_lint（静态规范）→ code_review_format（格式化）→ code_review_test（测试）→ code_review_bench + code_review_profile（性能）→ 最后 code_review_report 生成诊断报告并给出 Quality Gate 结论。',
  '性能诊断：code_review_bench 回答「程序运行消耗多少」；code_review_profile 给出热点函数 Top10（性能 bug 的直接证据），修复前后对比 p50 与热点占比。',
  '修复闭环：报告未通过（Quality Gate ❌）时，按报告中的 P0/P1 问题与性能热点逐一修复，然后重新运行审查工具并再次生成报告；直到报告结论为通过（✅），或达到轮次上限（默认 5 轮）后输出最终报告。',
  '报告产物：<项目>/.code-review/report-latest.md（最新）、report-<N>.md（每轮历史）、baseline.json（性能基线）。',
].join('\n')

/** Message-source plugin tag this package's injections carry. */
const PLUGIN_TAG = 'dsh-code-review'

/**
 * Whether the guidance message already lives in the session's visible surface.
 * @param agent - the agent whose session surface to inspect.
 * @returns true when the guidance is already present.
 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.events[seq]
    return event?.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === PLUGIN_TAG
  })
}

/** Render one tool value to the model as pretty-printed JSON text. */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** Common UI card for the review tools. */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/** JSON-safe view of findings (bounded, model-friendly). */
function summarizeFindings(findings: Finding[], limit = 30): JsonValue {
  return findings.slice(0, limit).map(f => ({
    severity: f.severity,
    file: f.file,
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.rule !== undefined ? { rule: f.rule } : {}),
    message: f.message.slice(0, 200),
  }))
}

/** Resolve the project argument into an absolute path. */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/**
 * Register the `code_review_*` tool set and, when enabled, the review-loop
 * guidance injection on the first agent step.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = {
    lint: defineTool({
      name: 'code_review_lint',
      description: '【静态规范审查】对指定项目运行 linter（JS/TS 默认 eslint；若存在 tsconfig.json 额外运行 tsc --noEmit 类型检查；Java/Python/PHP 走工具链注册表）。返回归一化问题清单（P0/P1 为阻塞级，P2/P3 为建议级）并保存到 .code-review/last-lint.json。',
      parameters: {
        project: { type: 'string', description: '被审查项目目录（绝对路径或相对当前工作区；缺省为当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args: { project?: string }) {
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
      },
      presentCall: args => presentCall('Run static lint', args),
    }),
    format: defineTool({
      name: 'code_review_format',
      description: '【格式化审查】检查项目代码格式（JS/TS 默认 prettier --check）。fix=true 时先执行 prettier --write + eslint --fix 再复查。保存结果到 .code-review/last-format.json。',
      parameters: {
        project: { type: 'string', description: '被审查项目目录（缺省为当前目录）' },
        fix: { type: 'boolean', description: '是否直接修复格式（默认 false，只检查）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args: { project?: string; fix?: boolean }) {
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
      },
      presentCall: args => presentCall('Check formatting', args),
    }),
    bench: defineTool({
      name: 'code_review_bench',
      description: '【程序级性能基准】反复运行指定命令 N 次（默认 5，排除冷启动），报告 p50/p90/均值/最快最慢/内存峰值(RSS)。回答「这个程序运行消耗多少性能」。结果保存到 .code-review/last-bench.json，报告轮次会与上轮基线自动对比（性能回归检测）。',
      parameters: {
        project: { type: 'string', description: '被审查项目目录（缺省为当前目录）' },
        command: { type: 'string', required: true, description: '要基准的完整命令，如 "node dist/index.js" 或 "python3 main.py --quick"' },
        iterations: { type: 'integer', description: '运行次数（默认 5，最少 2）' },
        timeoutMs: { type: 'integer', description: '单次超时（默认 120000ms）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args: { project?: string; command: string; iterations?: number; timeoutMs?: number }) {
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
      },
      presentCall: args => presentCall('Benchmark program', args),
    }),
    profile: defineTool({
      name: 'code_review_profile',
      description: '【函数级性能剖析】用语言 profiler（JS/TS 用 node --cpu-prof，Python 用 cProfile）剖析指定命令，解析出热点函数 Top10（自耗时/占比/位置）——这是排查性能 bug 的直接证据。结果保存到 .code-review/last-profile.json。',
      parameters: {
        project: { type: 'string', description: '被审查项目目录（缺省为当前目录）' },
        command: { type: 'string', required: true, description: '要剖析的命令（不含 profiler 包装），如 "dist/index.js" 或 "main.py"' },
        timeoutMs: { type: 'integer', description: '剖析超时（默认 120000ms）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args: { project?: string; command: string; timeoutMs?: number }) {
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
      },
      presentCall: args => presentCall('Profile hot functions', args),
    }),
    test: defineTool({
      name: 'code_review_test',
      description: '【测试执行】运行项目测试套件（JS/TS 默认 vitest run；Python 默认 pytest；Java 默认 mvn test；PHP 默认 phpunit），提取通过/失败/跳过/覆盖率。coverage=true 时附加覆盖率参数。结果保存到 .code-review/last-test.json。',
      parameters: {
        project: { type: 'string', description: '被审查项目目录（缺省为当前目录）' },
        coverage: { type: 'boolean', description: '是否收集覆盖率（默认 false）' },
        extraArgs: { type: 'array', items: { type: 'string' }, description: '附加 CLI 参数' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args: { project?: string; coverage?: boolean; extraArgs?: string[] }) {
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
      },
      presentCall: args => presentCall('Run test suite', args),
    }),
    report: defineTool({
      name: 'code_review_report',
      description: '【诊断报告 + Quality Gate】汇总本轮全部审查结果（lint/format/bench/profile/test），与上轮性能基线对比（回归检测），执行 Quality Gate 判定（无 P0/P1、格式合规、测试全绿、覆盖率达标、性能回归 < 阈值），生成 Markdown 报告 report-<N>.md 与 report-latest.md。返回 pass 结论——未通过时按报告修复后重跑全部审查工具再生成报告，直到 pass。',
      parameters: {
        project: { type: 'string', description: '被审查项目目录（缺省为当前目录）' },
        summary: { type: 'string', description: 'AI 附注摘要（优雅性评审意见、修复计划等）' },
        eleganceScore: { type: 'integer', description: 'AI 优雅性评分 0-100（命名/复杂度/重复/可读性/设计）' },
        testPassRate: { type: 'number', description: '测试通过率阈值 0-1（默认 1）' },
        coverageThreshold: { type: 'number', description: '覆盖率阈值 %（默认 0=不强制）' },
        perfRegressThresholdPct: { type: 'number', description: '性能回归容忍阈值 %（默认 10）' },
        eleganceThreshold: { type: 'number', description: '优雅性分阈值（默认 0=不强制）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args: { project?: string; summary?: string; eleganceScore?: number; testPassRate?: number; coverageThreshold?: number; perfRegressThresholdPct?: number; eleganceThreshold?: number }) {
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
      },
      presentCall: args => presentCall('Generate diagnostic report', args),
    }),
  }
  for (const tool of Object.values(tools)) ctx.tools.register(tool)

  if (config.injectGuidance) {
    ctx.on('agent/pre-step', async (
      { agent, messages, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (guidanceAlreadyInjected(agent)) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text', text: REVIEW_GUIDANCE }],
        source: { kind: 'plugin', plugin: PLUGIN_TAG, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

/** Apply prettier --write + eslint --fix in a JS/TS project. */
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

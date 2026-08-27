/**
 * DeepSeek Harness 的 AI 代码审查助手。
 *
 * 六个确定性的 `code_review_*` 工具驱动审查管线：
 *   1. `code_review_lint`    — 静态 lint（JS/TS 用 eslint + tsc；Java/Python/PHP
 *                             走工具链注册表）→ 归一化问题清单。
 *   2. `code_review_format`  — 格式化检查（或修复）→ 脏文件清单。
 *   3. `code_review_bench`   — 程序级基准：N 次运行、p50/p90/均值、内存峰值
 *                             RSS——「这个程序运行消耗多少性能」。
 *   4. `code_review_profile` — 函数级 CPU 剖析（JS/TS 用 v8 --cpu-prof，
 *                             Python 用 cProfile）→ 热点函数 Top10，
 *                             性能 bug 的直接证据。
 *   5. `code_review_test`    — 测试套件运行 + 覆盖率提取。
 *   6. `code_review_report`  — 聚合产物、与上一轮基线对比、评估质量门禁并
 *                             渲染 `report-<round>.md` + `report-latest.md`。
 *
 * 一切产物落在 `<项目>/.code-review/`（产物、基线、轮次状态），因此修复
 * → 再审查循环可续跑，每一轮都可对比。插件来源的引导消息告诉模型如何
 * 运行循环直到门禁通过。
 *
 * 架构分层：本文件是装配层（工具注册 + 引导注入），行为在 business/
 * （tools.ts 顶层 execute 编排）与 features/（纯能力砖块）。
 *
 * @module @deepseek-ai/dsh-code-review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeLint, executeFormat, executeBench, executeProfile, executeTest, executeReport } from './business/tools'
import type { ReviewToolConfig } from './business/tools'

/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
export const name = 'dsh-code-review'
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 被审查项目内的产物目录名。 */
  artifactsDir: string
  /** 是否在首个 step 注入审查闭环引导。 */
  injectGuidance: boolean
  /** 默认基准迭代次数。 */
  benchIterations: number
  /** 默认测试超时，ms。 */
  testTimeoutMs: number
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  artifactsDir: z.string().default('.code-review'),
  injectGuidance: z.boolean().default(true),
  benchIterations: z.number().default(5),
  testTimeoutMs: z.number().default(300_000),
})

/** 折叠进首个 agent step 的审查闭环引导。 */
const REVIEW_GUIDANCE = [
  '【代码审查】本会话具备 dsh-code-review 全套审查工具（code_review_lint/format/bench/profile/test/report），用于对 AI 写完的代码做自动审查、性能诊断与修复闭环。',
  '审查流程（按序执行）：先 code_review_lint（静态规范）→ code_review_format（格式化）→ code_review_test（测试）→ code_review_bench + code_review_profile（性能）→ 最后 code_review_report 生成诊断报告并给出 Quality Gate 结论。',
  '性能诊断：code_review_bench 回答「程序运行消耗多少」；code_review_profile 给出热点函数 Top10（性能 bug 的直接证据），修复前后对比 p50 与热点占比。',
  '修复闭环：报告未通过（Quality Gate ❌）时，按报告中的 P0/P1 问题与性能热点逐一修复，然后重新运行审查工具并再次生成报告；直到报告结论为通过（✅），或达到轮次上限（默认 5 轮）后输出最终报告。',
  '报告产物：<项目>/.code-review/report-latest.md（最新）、report-<N>.md（每轮历史）、baseline.json（性能基线）。',
].join('\n')

/** 本包注入消息的来源插件标签。 */
const PLUGIN_TAG = 'dsh-code-review'

/**
 * 引导消息是否已存在于会话可见面。
 * @param agent - 待检查会话面的 agent。
 * @returns 已存在时为 true。
 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.events[seq]
    return event?.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === PLUGIN_TAG
  })
}

/** 把工具返回值以美化 JSON 文本呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** code_review 工具的通用 UI 卡片。 */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/**
 * 注册 `code_review_*` 工具集，并按配置在首个 agent step 注入审查闭环引导。
 * 每个工具的 execute 委托给 business 层顶层函数（可独立测试）。
 * @param ctx - 携带工具注册表的注册上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const toolConfig: ReviewToolConfig = {
    artifactsDir: config.artifactsDir,
    benchIterations: config.benchIterations,
    testTimeoutMs: config.testTimeoutMs,
  }
  const tools = {
    lint: defineTool({
      name: 'code_review_lint',
      description: '【静态规范审查】对指定项目运行 linter（JS/TS 默认 eslint；若存在 tsconfig.json 额外运行 tsc --noEmit 类型检查；Java/Python/PHP 走工具链注册表）。返回归一化问题清单（P0/P1 为阻塞级，P2/P3 为建议级）并保存到 .code-review/last-lint.json。',
      parameters: {
        project: { type: 'string', description: '被审查项目目录（绝对路径或相对当前工作区；缺省为当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { project?: string }) => executeLint(toolConfig, args),
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
      execute: (args: { project?: string; fix?: boolean }) => executeFormat(toolConfig, args),
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
      execute: (args: { project?: string; command: string; iterations?: number; timeoutMs?: number }) => executeBench(toolConfig, args),
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
      execute: (args: { project?: string; command: string; timeoutMs?: number }) => executeProfile(toolConfig, args),
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
      execute: (args: { project?: string; coverage?: boolean; extraArgs?: string[] }) => executeTest(toolConfig, args),
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
      execute: (args: { project?: string; summary?: string; eleganceScore?: number; testPassRate?: number; coverageThreshold?: number; perfRegressThresholdPct?: number; eleganceThreshold?: number }) => executeReport(toolConfig, args),
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

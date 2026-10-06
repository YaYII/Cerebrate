/**
 * dsh-code-architecture —— 代码架构自检插件（注册进 DSH 供 AI 自检）。
 *
 * 八个工具：
 *   arch_check     —— 静态架构检查（注释语言/命名/重复功能/功能业务分离/依赖方向）
 *   arch_aop       —— AOP 执行观测（函数调用链 + 耗时热点，定位瓶颈与异常）
 *   arch_fingerprint —— 架构指纹与漂移检测（AI 防漂移锚点）
 *   arch_guide     —— 架构哲学指引（功能砖块/业务组合/AOP 思维）
 *   qa_metrics     —— 质量指标（圈复杂度/注释率/测试存在性 + 门禁）
 *   qa_mutation    —— 变异测试（变异分数 = 测试有效性硬证据）
 *   qa_gherkin     —— Gherkin/BDD 场景生成
 *   qa_report      —— 质量聚合报告（信心指数）
 *
 * 设计哲学：功能是砖块（原子、不随业务改变、只增不减）；业务是组合
 * （自由重组）。检查器只报事实，AI 依据事实决策。
 *
 * 架构分层：本文件是装配层（工具注册 + 引导注入）；行为在 business/
 * （tools.ts 顶层 execute 编排）与 features/（纯能力砖块）。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { executeArchCheck, executeFingerprint, executeAop, executeGuide, executeQaMetrics, executeQaMutation, executeQaGherkin, executeQaReport } from './business/tools'
import type { ArchToolConfig } from './business/tools'

/** 插件标识与依赖注入。 */
export const name = 'dsh-code-architecture'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-code-architecture': { kind: 'dsh-code-architecture'; form?: 'instructions' }
  }
}

/** 旧版 V3 会话消息迁移后的 kind；识别它以免升级后的会话重复注入。 */
const MIGRATED_PRODUCER_KIND = `plugin:${name}`
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 检查结果产物目录（相对被查项目）。 */
  artifactsDir: string
  /** 是否注入架构哲学指引到首个 step。 */
  injectGuidance: boolean
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  artifactsDir: z.string().default('.code-arch'),
  injectGuidance: z.boolean().default(true),
})

/** 架构哲学指引（注入到首个 agent step）。 */
const ARCH_GUIDANCE = [
  '【代码架构自检】本会话具备 dsh-code-architecture 工具：',
  '- arch_check：静态架构检查（注释必须中文、命名规范、重复功能、功能/业务分离、依赖方向），',
  '- arch_aop：AOP 执行观测——给目标入口注入探针，实测函数调用链与耗时，定位瓶颈与异常，',
  '- arch_guide：架构哲学（功能是砖块、业务是组合、AOP 观测思维）。',
  '写代码前先想分层：功能层（utils/core/shared）是原子砖块，永不绑定具体业务；',
  '业务层（services/controllers）只做编排组合。写完代码用 arch_check 自检，',
  '跑业务用 arch_aop 实测流转与耗时，让程序行为有证据、不靠猜。',
].join('\n')

/** 把工具返回值以美化 JSON 呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/**
 * 注册八个工具，并按配置注入架构哲学引导。每个工具的 execute 委托给
 * business 层顶层函数（可独立测试）。
 * @param ctx - 携带工具注册表的注册上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const toolConfig: ArchToolConfig = { artifactsDir: config.artifactsDir }

  ctx.tools.register(defineTool({
    name: 'arch_check',
    description: '【代码架构自检】扫描项目（注释语言/命名规范/重复功能/功能业务分离/依赖方向），返回归一化问题清单（P0/P1 阻塞级、P2 建议级）与统计。功能是砖块、业务是组合的强制检查。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string }) => executeArchCheck(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'arch_fingerprint',
    description: '【架构指纹与漂移检测】生成项目架构指纹（文件清单+sha256/分层边界/依赖方向/导出计数）保存为基线；再次调用对比基线，报告漂移（新增/修改/删除文件、分层迁移、依赖倒转）。AI 防漂移锚点。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
      save: { type: 'boolean', description: '是否把当前指纹保存为基线（默认 false，只对比）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string; save?: boolean }) => executeFingerprint(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'arch_aop',
    description: '【AOP 执行观测】给项目入口注入探针，实测函数调用链与耗时（热点 Top10 + 调用树 + 异常点）。回答「业务流转是否符合预期、瓶颈在哪、哪里耗时多少」。',
    parameters: {
      project: { type: 'string', description: '被观测项目目录（缺省为当前目录）' },
      entry: { type: 'string', description: '入口文件相对路径（缺省自动探测 src/index.ts 等）' },
      timeoutMs: { type: 'number', description: '探针超时（毫秒，默认 60000）' },
      baseline: { type: 'boolean', description: '保存本次观测为行为基线（默认 false，只对比）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string; entry?: string; timeoutMs?: number; baseline?: boolean }) => executeAop(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'arch_guide',
    description: '【架构哲学指引】功能砖块 + 业务组合 + AOP 观测思维——给 AI 的工程分层方法论。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: () => executeGuide(),
  }))

  // ── 质量保障体系：指标 / 变异 / Gherkin / 聚合报告 ──
  ctx.tools.register(defineTool({
    name: 'qa_metrics',
    description: '【质量指标】计算项目质量指标：圈复杂度（平均/最大/高危文件）、注释率、函数数、最长函数、测试存在性。每个指标带阈值门禁判定（P0/P1）。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string }) => executeQaMetrics(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'qa_mutation',
    description: '【变异测试】注入代码变异体（常量/算术/比较/布尔/条件/逻辑 6 类）跑测试，计算变异分数。分数低 = 测试是纸糊的（代码坏了测试看不出）。这是对代码信心的硬证据。',
    parameters: {
      project: { type: 'string', description: '被测试项目目录（缺省为当前目录，需含 vitest）' },
      file: { type: 'string', description: '限定变异单个文件（相对路径，可选）' },
      maxMutants: { type: 'number', description: '变异体数量上限（默认 30）' },
      timeoutMs: { type: 'number', description: '单次测试超时（毫秒，默认 120000）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string; file?: string; maxMutants?: number; timeoutMs?: number }) => executeQaMutation(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'qa_gherkin',
    description: '【Gherkin/BDD 场景】从业务层代码自动生成 Given/When/Then 场景骨架（正常/异常/边界三路径），输出特征文件文本。让测试从实现细节提升到业务行为。',
    parameters: {
      project: { type: 'string', description: '项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string }) => executeQaGherkin(toolConfig, args),
  }))

  ctx.tools.register(defineTool({
    name: 'qa_report',
    description: '【质量聚合报告】汇总全部质量门禁（架构自检/质量指标/变异分数/覆盖率）给出信心指数与通过/不通过结论。只有全绿才值得信任。',
    parameters: {
      project: { type: 'string', description: '项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    execute: (args: { project?: string }) => executeQaReport(toolConfig, args),
  }))

  if (config.injectGuidance) {
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (agent.session.surface.nodes.some(seq => {
        const event = agent.session.eventAt(seq)
        if (event?.type !== 'user/message') return false
        const kind: string = event.data.source.kind
        return kind === name || kind === MIGRATED_PRODUCER_KIND
      })) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text' as const, text: ARCH_GUIDANCE }],
        source: { kind: name, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter' as const, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

/** 供程序化使用的再导出（来自 features 能力层）。 */
export { runArchChecks, collectSourceFiles } from './features/checks'
export type { ArchFinding, ArchReport } from './features/checks'
export { runAopProbe, aopReportText, findEntry } from './features/aop'
export type { AopResult, CallRecord } from './features/aop'
export { fingerprintProject, diffFingerprints } from './features/fingerprint'
export type { ArchFingerprint, FingerprintDiff } from './features/fingerprint'
export { qualityReport } from './features/metrics'
export { runMutation } from './features/mutation'
export { generateGherkin, gherkinFeatureText } from './features/gherkin'

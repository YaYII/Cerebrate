/**
 * dsh-code-architecture —— 代码架构自检插件（注册进 DSH 供 AI 自检）。
 *
 * 三个工具：
 *   arch_check —— 静态架构检查（注释语言/命名/重复功能/功能业务分离/依赖方向）
 *   arch_aop   —— AOP 执行观测（函数调用链 + 耗时热点，定位瓶颈与异常）
 *   arch_guide —— 架构哲学指引（功能砖块/业务组合/AOP 思维）
 *
 * 设计哲学：功能是砖块（原子、不随业务改变、只增不减）；业务是组合
 * （自由重组）。检查器只报事实，AI 依据事实决策。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { resolve, basename } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { runArchChecks } from './checks'
import { fingerprintProject, diffFingerprints } from './fingerprint'
import { runAopProbe, aopReportText, findEntry } from './aop'

/** 插件标识与依赖注入。 */
export const name = 'dsh-code-architecture'
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

/** 解析项目路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/** 保存产物到 .code-arch/。 */
function saveArtifact(projectDir: string, dir: string, name: string, data: unknown): string {
  const absDir = resolve(projectDir, dir)
  mkdirSync(absDir, { recursive: true })
  const path = resolve(absDir, name)
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8')
  return path
}

/** 注册三个工具。 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'arch_check',
    description: '【代码架构自检】扫描项目（注释语言/命名规范/重复功能/功能业务分离/依赖方向），返回归一化问题清单（P0/P1 阻塞级、P2 建议级）与统计。功能是砖块、业务是组合的强制检查。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args: { project?: string }) {
      const projectDir = resolveProject(args.project, process.cwd())
      const report = runArchChecks(projectDir)
      saveArtifact(projectDir, config.artifactsDir, 'last-arch.json', report)
      const blockers = report.findings.filter(f => f.severity === 'P0' || f.severity === 'P1').length
      return {
        status: 'ok',
        data: {
          stats: report.stats,
          total: report.findings.length,
          blockers,
          findings: report.findings.slice(0, 50).map(f => ({
            rule: f.rule, severity: f.severity, file: f.file,
            ...(f.line !== undefined ? { line: f.line } : {}),
            message: f.message,
          })),
          artifact: resolve(projectDir, config.artifactsDir, 'last-arch.json'),
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'arch_fingerprint',
    description: '【架构指纹与漂移检测】生成项目架构指纹（文件清单+sha256/分层边界/依赖方向/导出计数）保存为基线；再次调用对比基线，报告漂移（新增/修改/删除文件、分层迁移、依赖倒转）。AI 防漂移锚点。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
      save: { type: 'boolean', description: '是否把当前指纹保存为基线（默认 false，只对比）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args: { project?: string; save?: boolean }) {
      const projectDir = resolveProject(args.project, process.cwd())
      const current = fingerprintProject(projectDir)
      const baselinePath = resolve(projectDir, config.artifactsDir, 'arch-fingerprint.json')
      const { existsSync } = await import('node:fs')
      const baseline = existsSync(baselinePath)
        ? JSON.parse(await import('node:fs').then(m => m.readFileSync(baselinePath, 'utf8')))
        : null
      if (args.save || !baseline) {
        saveArtifact(projectDir, config.artifactsDir, 'arch-fingerprint.json', current)
        return {
          status: 'ok',
          data: {
            saved: true,
            note: baseline ? '基线已更新' : '首次生成基线',
            stats: {
              files: Object.keys(current.files).length,
              featureFiles: current.featureFiles.length,
              businessFiles: current.businessFiles.length,
              dependencyViolations: current.dependencyViolations.length,
              exportCounts: current.exportCounts,
            },
          },
        }
      }
      const diff = diffFingerprints(baseline, current)
      return {
        status: 'ok',
        data: {
          saved: false,
          drifted: diff.drifted,
          summary: {
            added: diff.added.length,
            modified: diff.modified.length,
            deleted: diff.deleted.length,
            layerMoved: diff.layerMoved.length,
            dependencyChanged: diff.dependencyChanged.length,
          },
          details: {
            added: diff.added.slice(0, 20),
            modified: diff.modified.slice(0, 20),
            deleted: diff.deleted.slice(0, 20),
            layerMoved: diff.layerMoved.slice(0, 10),
            dependencyChanged: diff.dependencyChanged.slice(0, 10),
          },
          baseline: baselinePath,
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'arch_aop',
    description: '【AOP 执行观测】给项目入口注入探针，实测函数调用链与耗时（热点 Top10 + 调用树 + 异常点）。回答「业务流转是否符合预期、瓶颈在哪、哪里耗时多少」。',
    parameters: {
      project: { type: 'string', description: '被观测项目目录（缺省为当前目录）' },
      entry: { type: 'string', description: '入口文件相对路径（缺省自动探测 src/index.ts 等）' },
      timeoutMs: { type: 'number', description: '探针超时（毫秒，默认 60000）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args: { project?: string; entry?: string; timeoutMs?: number }) {
      const projectDir = resolveProject(args.project, process.cwd())
      const entryRel = args.entry ?? findEntry(projectDir) ?? ''
      if (!entryRel) {
        return { status: 'error', message: '未找到入口文件（尝试 src/index.ts、src/main.ts、index.ts），请用 entry 参数指定' }
      }
      const entryAbs = resolve(projectDir, entryRel)
      const result = runAopProbe({ entryAbs, cwd: projectDir, ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) })
      if (result.calls.length === 0) {
        return { status: 'ok', data: { calls: 0, note: '未观测到调用（入口可能未自动执行；可设置 AOP_CALL_ENTRY=1 或用 CLI 型入口）' } }
      }
      const report = aopReportText(result)
      saveArtifact(projectDir, config.artifactsDir, 'last-aop.md', report)
      return {
        status: 'ok',
        data: {
          calls: result.calls.length,
          threw: result.threw,
          hotspots: result.hotspots.slice(0, 10),
          report,
          artifact: resolve(projectDir, config.artifactsDir, 'last-aop.md'),
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'arch_guide',
    description: '【架构哲学指引】功能砖块 + 业务组合 + AOP 观测思维——给 AI 的工程分层方法论。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute() {
      return {
        status: 'ok',
        data: {
          philosophy: [
            '1. 功能是砖块：功能层（utils/core/shared/features）的代码是原子的、可复用的、',
            '   不随业务改变的。它只增不减——新增功能 = 新增砖块，绝不改旧砖块。',
            '2. 业务是组合：业务层（services/controllers/business）只做编排组合，',
            '   把砖块按业务规则拼起来。业务可以自由重组，而砖块保持不变。',
            '3. 强制分离：功能层禁止 import 业务层（依赖单向）；功能层禁止出现业务专属词汇',
            '   （订单/支付/用户等——业务通过参数与配置注入）。',
            '4. AOP 观测思维：给函数加观测（耗时/调用链/异常），得到业务流转的实测证据，',
            '   定位「哪里与预期不符、哪里耗时、瓶颈在哪」——debug 不靠猜，靠证据。',
            '5. 检查闭环：写完代码 arch_check 自检规范；跑业务 arch_aop 实测流转；',
            '   问题即证据，修复后再自检，直到全绿。',
          ].join('\n'),
        },
      }
    },
  }))

  if (config.injectGuidance) {
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (agent.session.surface.nodes.some(seq => {
        const event = agent.session.events[seq]
        return event?.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === name
      })) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text' as const, text: ARCH_GUIDANCE }],
        source: { kind: 'plugin' as const, plugin: name, form: 'instructions' as const },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter' as const, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

/** 供程序化使用的再导出。 */
export { runArchChecks, collectSourceFiles } from './checks'
export type { ArchFinding, ArchReport } from './checks'
export { runAopProbe, aopReportText, findEntry } from './aop'
export type { AopResult, CallRecord } from './aop'

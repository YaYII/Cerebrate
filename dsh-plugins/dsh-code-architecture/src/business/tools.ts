/**
 * dsh-code-architecture 八个工具的业务编排层——顶层执行函数，独立可测。
 *
 * 每个工具的 execute 都是顶层导出函数（可注入真实/假项目目录直接单元
 * 测试），apply 只做装配引用。功能能力（检查器/指纹/AOP/指标/变异/Gherkin）
 * 在 features/，本文件只组合它们并落盘产物。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { runArchChecks } from '../features/checks'
import { fingerprintProject, diffFingerprints } from '../features/fingerprint'
import { qualityReport } from '../features/metrics'
import { runMutation } from '../features/mutation'
import { generateGherkin, gherkinFeatureText } from '../features/gherkin'
import { runAopProbe, aopReportText, findEntry } from '../features/aop'

/** 插件配置（工具执行所需的最小形状）。 */
export interface ArchToolConfig {
  artifactsDir: string
}

/** 把项目参数解析为绝对路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/** 保存产物到项目的 .code-arch/ 目录。 */
function saveArtifact(projectDir: string, dir: string, name: string, data: unknown): string {
  const absDir = resolve(projectDir, dir)
  mkdirSync(absDir, { recursive: true })
  const path = resolve(absDir, name)
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8')
  return path
}

/**
 * arch_check 顶层执行函数：静态架构检查（注释语言/命名/重复/分离/依赖方向），
 * 归一化问题清单并落盘。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project（被检查项目目录）。
 * @returns { status, data: { stats, total, blockers, findings, artifact } }。
 */
export async function executeArchCheck(
  config: ArchToolConfig,
  args: { project?: string },
): Promise<Record<string, JsonValue>> {
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
}

/**
 * arch_fingerprint 顶层执行函数：生成/对比架构指纹，报告漂移。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project / save（是否保存基线）。
 * @returns { status, data: { saved, stats | drifted, summary, details, baseline } }。
 */
export async function executeFingerprint(
  config: ArchToolConfig,
  args: { project?: string; save?: boolean },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const current = fingerprintProject(projectDir)
  const baselinePath = resolve(projectDir, config.artifactsDir, 'arch-fingerprint.json')
  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
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
}

/**
 * arch_aop 顶层执行函数：注入探针实测调用链与耗时，支持行为基线保存与漂移对比。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project / entry / timeoutMs / baseline。
 * @returns { status, data: { calls, threw, hotspots, report, ...基线相关 } }。
 */
export async function executeAop(
  config: ArchToolConfig,
  args: { project?: string; entry?: string; timeoutMs?: number; baseline?: boolean },
): Promise<Record<string, JsonValue>> {
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
  const baselinePath = resolve(projectDir, config.artifactsDir, 'aop-baseline.json')
  // 行为基线：保存本次热点快照，供下次对比漂移
  if (args.baseline) {
    saveArtifact(projectDir, config.artifactsDir, 'aop-baseline.json', { savedAt: new Date().toISOString(), hotspots: result.hotspots })
    return {
      status: 'ok',
      data: {
        calls: result.calls.length,
        threw: result.threw,
        hotspots: result.hotspots.slice(0, 10),
        baselineSaved: true,
        report,
        artifact: resolve(projectDir, config.artifactsDir, 'last-aop.md'),
      },
    }
  }
  // 对比基线：报告行为漂移（函数耗时变化/新增热点/消失热点）
  if (existsSync(baselinePath)) {
    const base = JSON.parse(readFileSync(baselinePath, 'utf8')) as { hotspots: Array<{ name: string; count: number; totalMs: number; avgMs: number; maxMs: number }> }
    const baseMap = new Map(base.hotspots.map(h => [h.name, h]))
    const curMap = new Map(result.hotspots.map(h => [h.name, h]))
    const drift: Array<{ name: string; change: string; totalMs?: number; baselineMs?: number }> = []
    for (const [name, h] of curMap) {
      const b = baseMap.get(name)
      if (!b) drift.push({ name, change: '新增热点', totalMs: h.totalMs })
      else {
        const pct = b.totalMs === 0 ? 0 : Math.round((h.totalMs - b.totalMs) / b.totalMs * 100)
        if (Math.abs(pct) >= 20) drift.push({ name, change: pct > 0 ? '耗时上升 ' + pct + '%' : '耗时下降 ' + Math.abs(pct) + '%', totalMs: h.totalMs, baselineMs: b.totalMs })
      }
    }
    for (const [name, h] of baseMap) {
      if (!curMap.has(name)) drift.push({ name, change: '热点消失', baselineMs: h.totalMs })
    }
    return {
      status: 'ok',
      data: {
        calls: result.calls.length,
        threw: result.threw,
        hotspots: result.hotspots.slice(0, 10),
        baselineCompared: true,
        behaviorDrift: drift,
        report,
        artifact: resolve(projectDir, config.artifactsDir, 'last-aop.md'),
      },
    }
  }
  return {
    status: 'ok',
    data: {
      calls: result.calls.length,
      threw: result.threw,
      hotspots: result.hotspots.slice(0, 10),
      baselineCompared: false,
      note: '无基线（可用 baseline=true 保存首次观测）',
      report,
      artifact: resolve(projectDir, config.artifactsDir, 'last-aop.md'),
    },
  }
}

/** arch_guide 顶层执行函数：架构哲学指引（静态内容，无 IO）。 */
export async function executeGuide(): Promise<Record<string, JsonValue>> {
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
}

/**
 * qa_metrics 顶层执行函数：质量指标（圈复杂度/注释率/函数数/测试存在性）+ 门禁。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project。
 * @returns { status, data: { totals, gates, topComplexity, artifact } }。
 */
export async function executeQaMetrics(
  config: ArchToolConfig,
  args: { project?: string },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const report = qualityReport(projectDir)
  saveArtifact(projectDir, config.artifactsDir, 'qa-metrics.json', report.totals)
  return {
    status: 'ok',
    data: {
      totals: report.totals,
      gates: report.gates,
      topComplexity: report.files.slice().sort((a, b) => b.cyclomatic - a.cyclomatic).slice(0, 5).map(f => ({ file: f.relPath, cyclomatic: f.cyclomatic, lines: f.lines })),
      artifact: resolve(projectDir, config.artifactsDir, 'qa-metrics.json'),
    },
  }
}

/**
 * qa_mutation 顶层执行函数：注入变异体跑测试，计算变异分数（测试有效性硬证据）。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project / file / maxMutants / timeoutMs。
 * @returns { status, data: { total, killed, survived, score, scorePercent, quality, survivors, artifact } }。
 */
export async function executeQaMutation(
  config: ArchToolConfig,
  args: { project?: string; file?: string; maxMutants?: number; timeoutMs?: number },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const result = runMutation({
    project: projectDir,
    ...(args.file ? { file: args.file } : {}),
    ...(args.maxMutants ? { maxMutants: args.maxMutants } : {}),
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  })
  if ('baselineFailed' in result) {
    return { status: 'error', message: '基线测试未通过——变异测试要求先有全绿测试（测试存在且通过才有意义）' }
  }
  saveArtifact(projectDir, config.artifactsDir, 'qa-mutation.json', result)
  return {
    status: 'ok',
    data: {
      total: result.total,
      killed: result.killed,
      survived: result.survived,
      score: result.score,
      scorePercent: Math.round(result.score * 100) + '%',
      quality: result.score >= 0.8 ? '优秀（测试有效）' : result.score >= 0.5 ? '及格（测试有盲区）' : '危险（测试是纸糊的）',
      survivors: result.survivors.slice(0, 10),
      artifact: resolve(projectDir, config.artifactsDir, 'qa-mutation.json'),
    },
  }
}

/**
 * qa_gherkin 顶层执行函数：从业务层代码生成 Given/When/Then 场景骨架。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project。
 * @returns { status, data: { scenarioCount, functions, feature, artifact } }。
 */
export async function executeQaGherkin(
  config: ArchToolConfig,
  args: { project?: string },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const scenarios = generateGherkin(projectDir)
  const feature = gherkinFeatureText(scenarios)
  saveArtifact(projectDir, config.artifactsDir, 'qa-gherkin.feature', feature)
  return {
    status: 'ok',
    data: {
      scenarioCount: scenarios.length,
      functions: scenarios.map(s => ({ file: s.file, function: s.functionName, feature: s.feature })),
      feature,
      artifact: resolve(projectDir, config.artifactsDir, 'qa-gherkin.feature'),
    },
  }
}

/**
 * qa_report 顶层执行函数：聚合全部质量门禁（架构自检/质量指标/变异分数/
 * BDD 覆盖）给出信心指数与结论。
 * @param config - 插件配置（产物目录）。
 * @param args - 工具入参：project。
 * @returns { status, data: { confidence, conclusion, passed, gates, artifact } }。
 */
export async function executeQaReport(
  config: ArchToolConfig,
  args: { project?: string },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  // 聚合：架构自检 + 质量指标 + Gherkin 场景数 + 变异分数（信心基石）
  const arch = runArchChecks(projectDir)
  const metrics = qualityReport(projectDir)
  const scenarios = generateGherkin(projectDir)
  const p0p1 = arch.findings.filter(f => f.severity === 'P0' || f.severity === 'P1').length
  // 读上次变异测试产物（qa-mutation.json），若有则纳入门禁
  let mutationGate: { name: string; pass: boolean; detail: string } | null = null
  const mutPath = resolve(projectDir, config.artifactsDir, 'qa-mutation.json')
  if (existsSync(mutPath)) {
    const mut = JSON.parse(readFileSync(mutPath, 'utf8')) as { score: number; total: number }
    if (mut.total > 0) {
      mutationGate = {
        name: '变异分数',
        pass: mut.score >= 0.8,
        detail: Math.round(mut.score * 100) + '%（阈值 ≥80%，测试有效性硬证据）',
      }
    }
  }
  const gateResults = [
    { name: '架构自检（P0/P1）', pass: p0p1 === 0, detail: p0p1 === 0 ? '无阻塞级问题' : p0p1 + ' 个阻塞级问题' },
    ...metrics.gates.map(g => ({ name: g.name, pass: g.pass, detail: g.value + '（阈值 ' + g.threshold + '）' })),
    { name: 'BDD 场景覆盖', pass: scenarios.length > 0, detail: scenarios.length + ' 个业务函数已生成场景' },
    ...(mutationGate ? [mutationGate] : []),
  ]
  const passed = gateResults.filter(g => g.pass).length
  const total = gateResults.length
  const confidence = Math.round(passed / total * 100)
  saveArtifact(projectDir, config.artifactsDir, 'qa-report.json', { confidence, gates: gateResults })
  return {
    status: 'ok',
    data: {
      confidence: confidence + '%',
      conclusion: confidence >= 80 ? '可信任（建议补变异测试复核）' : confidence >= 50 ? '有风险（修复阻塞项）' : '不可信任（必须修复）',
      passed: passed + '/' + total + ' 门禁通过',
      gates: gateResults,
      artifact: resolve(projectDir, config.artifactsDir, 'qa-report.json'),
    },
  }
}

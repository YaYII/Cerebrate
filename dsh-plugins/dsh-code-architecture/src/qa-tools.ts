/**
 * 质量保障工具注册器：qa_metrics / qa_mutation / qa_gherkin / qa_report。
 *
 * 从 index.ts 拆出（功能砖块：装配层只做组合，工具注册各归其位），
 * 降低装配层圈复杂度，让每个工具的实现职责单一、可独立测试。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { runArchChecks } from './checks'
import { qualityReport } from './metrics'
import { runMutation } from './mutation'
import { generateGherkin, gherkinFeatureText } from './gherkin'

/** 工具返回值以美化 JSON 呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 解析项目路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/** 保存产物到项目 .code-arch/ 目录。 */
function saveArtifact(projectDir: string, dir: string, name: string, data: unknown): string {
  const absDir = resolve(projectDir, dir)
  mkdirSync(absDir, { recursive: true })
  const path = resolve(absDir, name)
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8')
  return path
}

/** 注册全部质量保障工具（指标/变异/Gherkin/聚合报告）。 */
export function registerQaTools(ctx: Context, config: { artifactsDir: string }): void {
  // ── 质量指标：圈复杂度/注释率/测试存在性，阈值门禁 ──
  ctx.tools.register(defineTool({
    name: 'qa_metrics',
    description: '【质量指标】计算项目质量指标：圈复杂度（平均/最大/高危文件）、注释率、函数数、最长函数、测试存在性。每个指标带阈值门禁判定（P0/P1）。',
    parameters: {
      project: { type: 'string', description: '被检查项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args: { project?: string }): Promise<Record<string, JsonValue>> {
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
    },
  }))

  // ── 变异测试：注入变异体跑测试，变异分数 = 测试有效性的硬证据 ──
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
    async execute(args: { project?: string; file?: string; maxMutants?: number; timeoutMs?: number }): Promise<Record<string, JsonValue>> {
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
    },
  }))

  // ── Gherkin 场景生成：业务行为 Given/When/Then ──
  ctx.tools.register(defineTool({
    name: 'qa_gherkin',
    description: '【Gherkin/BDD 场景】从业务层代码自动生成 Given/When/Then 场景骨架（正常/异常/边界三路径），输出特征文件文本。让测试从实现细节提升到业务行为。',
    parameters: {
      project: { type: 'string', description: '项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args: { project?: string }): Promise<Record<string, JsonValue>> {
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
    },
  }))

  // ── 质量聚合报告：信心指数 + 门禁通过/不通过 ──
  ctx.tools.register(defineTool({
    name: 'qa_report',
    description: '【质量聚合报告】汇总全部质量门禁（架构自检/质量指标/变异分数/覆盖率）给出信心指数与通过/不通过结论。只有全绿才值得信任。',
    parameters: {
      project: { type: 'string', description: '项目目录（缺省为当前目录）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args: { project?: string }): Promise<Record<string, JsonValue>> {
      const projectDir = resolveProject(args.project, process.cwd())
      // 聚合：架构自检 + 质量指标 + Gherkin 场景数 + 变异分数（信心基石）
      const arch = runArchChecks(projectDir)
      const metrics = qualityReport(projectDir)
      const scenarios = generateGherkin(projectDir)
      const p0p1 = arch.findings.filter(f => f.severity === 'P0' || f.severity === 'P1').length
      // 读上次变异测试产物（qa-mutation.json），若有则纳入门禁
      let mutationGate: { name: string; pass: boolean; detail: string } | null = null
      const { existsSync: es, readFileSync: rf } = await import('node:fs')
      const mutPath = resolve(projectDir, config.artifactsDir, 'qa-mutation.json')
      if (es(mutPath)) {
        const mut = JSON.parse(rf(mutPath, 'utf8')) as { score: number; total: number }
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
    },
  }))
}

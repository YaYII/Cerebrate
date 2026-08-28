/**
 * dsh-program-cognition 六个工具的业务编排层 —— 顶层执行函数，独立可测。
 *
 * 每个工具的 execute 都是顶层导出函数（可注入真实/假项目目录直接单元
 * 测试），index.ts 只做装配引用。功能能力（扫描/模板/注入/采集/图谱/
 * Agent 行为/脱敏/翻译）在 features/，本文件只组合它们并落盘产物。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { scanProject, type ScanResult } from '../features/scanner'
import { generateLogPoints, type LogPoint } from '../features/templates'
import { instrumentProject, revertProject } from '../features/instrument'
import { runCogTrace, traceReportText, findEntry, type TraceRecord } from '../features/collector'
import { buildGraph, sliceGraph, graphReportText, type CogGraph } from '../features/graph'
import {
  recordFromSessionEvent, agentReportText, type AgentBehaviorRecord, type AgentTraceBuffer,
} from '../features/agentTrace'
import {
  traceTranslatePrompt, agentTranslatePrompt, templateTranslate, type TranslateFn,
} from '../features/translate'

/** 插件配置（工具执行所需的最小形状）。 */
export interface CogToolConfig {
  /** 产物目录（相对被观测项目）。 */
  artifactsDir: string
  /** 语义翻译能力（由装配层注入；无 llm 时为 undefined → 模板降级）。 */
  translate?: TranslateFn
}

/** 把项目参数解析为绝对路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/** 保存产物到项目的 artifactsDir 目录。 */
function saveArtifact(projectDir: string, dir: string, name: string, data: unknown): string {
  const absDir = resolve(projectDir, dir)
  mkdirSync(absDir, { recursive: true })
  const path = resolve(absDir, name)
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8')
  return path
}

/** 从产物目录读取 JSON（不存在返回 null）。 */
function readArtifact<T>(projectDir: string, dir: string, name: string): T | null {
  const path = resolve(projectDir, dir, name)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return null }
}

/**
 * cog_scan 顶层执行函数：静态砖块/服务分类，落盘档案。
 * @param config - 插件配置。
 * @param args - 工具入参。
 * @returns 扫描结果摘要。
 */
export async function executeCogScan(
  config: CogToolConfig,
  args: { project?: string },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const scan = scanProject(projectDir)
  saveArtifact(projectDir, config.artifactsDir, 'bricks.json', scan)
  saveArtifact(projectDir, config.artifactsDir, 'last-scan.json', scan)
  return {
    status: 'ok',
    data: {
      stats: scan.stats,
      bricks: scan.functions.filter(f => f.kind === 'brick').slice(0, 50).map(f => ({
        id: f.id, evidence: f.evidence, keywords: f.keywords, loc: f.loc,
      })),
      findings: scan.findings.slice(0, 20),
      artifact: resolve(projectDir, config.artifactsDir, 'bricks.json'),
    },
  }
}

/**
 * cog_instrument 顶层执行函数：生成埋点并注入（dryRun 默认）。
 * @param config - 插件配置。
 * @param args - 工具入参。
 * @returns 埋点清单与注入结果。
 */
export async function executeCogInstrument(
  config: CogToolConfig,
  args: { project?: string; scope?: string; dryRun?: boolean; revert?: string },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  // 回滚优先：revert 参数携带备份目录时直接恢复
  if (args.revert) {
    const backupDir = args.revert.startsWith('/') ? args.revert : resolve(projectDir, args.revert)
    const restored = revertProject(projectDir, backupDir)
    return { status: 'ok', data: { reverted: true, restored, note: '已从备份恢复原始文件' } }
  }
  const scan = scanProject(projectDir)
  const points = generateLogPoints(scan, { ...args.scope === undefined ? {} : { scope: args.scope } })
  const dryRun = args.dryRun !== false
  const result = instrumentProject(projectDir, points, { dryRun })
  saveArtifact(projectDir, config.artifactsDir, 'logpoints.json', points)
  return {
    status: 'ok',
    data: {
      points: result.points.map(p => ({
        id: p.id, target: p.target, phase: p.phase, level: p.level, template: p.template,
        ...p.sideEffect === undefined ? {} : { sideEffect: p.sideEffect },
      })),
      diff: result.diff,
      written: result.written,
      writtenFiles: result.writtenFiles,
      ...result.backupDir === null ? {} : { backupDir: result.backupDir },
      note: dryRun ? 'dryRun 模式：未写入源码，确认后以 dryRun=false 重新调用' : '已写入源码（备份见 backupDir，可 revert 回滚）',
      artifact: resolve(projectDir, config.artifactsDir, 'logpoints.json'),
    },
  }
}

/**
 * cog_trace 顶层执行函数：运行业务入口采集行为时序链。
 * @param config - 插件配置。
 * @param args - 工具入参。
 * @returns 时序链报告。
 */
export async function executeCogTrace(
  config: CogToolConfig,
  args: { project?: string; entry?: string; timeoutMs?: number },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const scan = scanProject(projectDir)
  const entryAbs = args.entry ? resolve(projectDir, args.entry) : findEntry(projectDir)
  if (!entryAbs || !existsSync(entryAbs)) {
    return { status: 'error', error: { code: 400, message: '未找到入口文件（自动探测 src/index.ts 等，或用 entry 参数指定）' } }
  }
  const result = runCogTrace({ projectDir, entryAbs, timeoutMs: args.timeoutMs ?? 60000 })
  // 追加到行为流
  const recordsPath = saveArtifact(projectDir, config.artifactsDir, 'behaviors.ndjson',
    result.records.map(r => JSON.stringify(r)).join('\n'))
  saveArtifact(projectDir, config.artifactsDir, 'last-trace.json', { ...result, records: result.records.slice(-200) })
  return {
    status: 'ok',
    data: {
      entry: entryAbs.replace(projectDir + '/', ''),
      recordCount: result.records.length,
      entryFailed: result.entryFailed,
      report: traceReportText(result),
      ...result.rawOutput === '' ? {} : { rawOutput: result.rawOutput },
      artifact: recordsPath,
    },
  }
}

/**
 * cog_graph 顶层执行函数：聚合静态档案与行为记录为认知图谱。
 * @param config - 插件配置。
 * @param args - 工具入参。
 * @returns 图谱摘要。
 */
export async function executeCogGraph(
  config: CogToolConfig,
  args: { project?: string; focus?: string; depth?: number; semantic?: boolean },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  const scan = readArtifact<ScanResult>(projectDir, config.artifactsDir, 'bricks.json')
    ?? scanProject(projectDir)
  const behaviors = readBehaviorRecords(projectDir, config.artifactsDir)
  let graph = buildGraph(scan, behaviors)
  graph = sliceGraph(graph, args.focus, args.depth ?? 2)
  if (args.semantic === true) {
    // 有翻译器走宿主 LLM，否则降级模板拼接（功能可用性不受损）
    if (config.translate) {
      try {
        const prompt = traceTranslatePrompt(behaviors, projectDir.split('/').pop() ?? '项目')
        graph.semantic = await config.translate(prompt)
      } catch {
        graph.semantic = templateTranslate(behaviors, 'trace')
      }
    } else {
      graph.semantic = templateTranslate(behaviors, 'trace')
    }
  }
  saveArtifact(projectDir, config.artifactsDir, 'graph.json', graph)
  return {
    status: 'ok',
    data: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      layers: graph.layers,
      hotspots: graph.hotspots.slice(0, 10),
      gaps: graph.gaps.slice(0, 15).map(g => ({ from: g.from, to: g.to })),
      ...graph.semantic === undefined ? {} : { semantic: graph.semantic },
      report: graphReportText(graph),
      artifact: resolve(projectDir, config.artifactsDir, 'graph.json'),
    },
  }
}

/** 读取引擎 A 行为流（ndjson）。 */
function readBehaviorRecords(projectDir: string, dir: string): TraceRecord[] {
  const path = resolve(projectDir, dir, 'behaviors.ndjson')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) as TraceRecord } catch { return null }
  }).filter((r): r is TraceRecord => r !== null)
}

/** 读取引擎 B 行为流（ndjson）。 */
function readAgentRecords(projectDir: string, dir: string): AgentBehaviorRecord[] {
  const path = resolve(projectDir, dir, 'agent-behaviors.ndjson')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) as AgentBehaviorRecord } catch { return null }
  }).filter((r): r is AgentBehaviorRecord => r !== null)
}

/**
 * cog_agent 顶层执行函数：查询 AI 自身行为流。
 * @param config - 插件配置。
 * @param args - 工具入参。
 * @returns 行为流摘要与过滤结果。
 */
export async function executeCogAgent(
  config: CogToolConfig,
  args: { project?: string; sessionId?: string; turn?: number; tool?: string; failed?: boolean; semantic?: boolean },
): Promise<Record<string, JsonValue>> {
  const projectDir = resolveProject(args.project, process.cwd())
  let records = readAgentRecords(projectDir, config.artifactsDir)
  if (args.sessionId) records = records.filter(r => r.sessionId === args.sessionId)
  if (args.turn !== undefined) records = records.filter(r => r.turn === args.turn)
  if (args.tool) records = records.filter(r => r.toolName === args.tool)
  if (args.failed === true) records = records.filter(r => r.failed)
  const sessionId = args.sessionId ?? records[0]?.sessionId ?? 'all'
  let semantic: string | undefined
  if (args.semantic === true && config.translate) {
    try {
      semantic = await config.translate(agentTranslatePrompt(records))
    } catch {
      semantic = templateTranslate(records, 'agent')
    }
  }
  const toolCalls = records.filter(r => r.kind === 'tool-call').length
  const failed = records.filter(r => r.failed).length
  const ghostPaths = records.filter(r => r.kind === 'inbox' || (r.kind === 'step-proposal' && r.failed))
  saveArtifact(projectDir, config.artifactsDir, 'last-agent.json', { sessionId, records: records.slice(-300) })
  return {
    status: 'ok',
    data: {
      sessionId,
      recordCount: records.length,
      stats: { toolCalls, failed },
      ghostPaths: ghostPaths.slice(0, 10).map(g => ({ kind: g.kind, turn: g.turn, summary: g.summary })),
      failures: records.filter(r => r.failed).slice(0, 10).map(f => ({ turn: f.turn, summary: f.summary })),
      ...semantic === undefined ? {} : { semantic },
      report: agentReportText(records, sessionId),
      artifact: resolve(projectDir, config.artifactsDir, 'last-agent.json'),
    },
  }
}

/**
 * cog_guide 顶层执行函数：认知可观测性哲学指引。
 * @returns 指引文本。
 */
export async function executeCogGuide(): Promise<Record<string, JsonValue>> {
  const text = [
    '# 认知可观测性指引（功能是砖块、业务是组合、行为有证据）',
    '',
    '## 三层心智',
    '1. **砖块层**：纯逻辑、无状态、单一职责的 Function —— AI 可拼装的乐高块。',
    '2. **组合层**：Service 只做编排组合，自由重组；改业务逻辑只换砖块，不破坏大楼。',
    '3. **证据层**：业务流转靠实测（cog_trace），AI 行为靠记录（cog_agent），不靠猜。',
    '',
    '## 使用顺序',
    '- 新项目先 cog_scan：知道砖块/服务在哪、缺什么职责。',
    '- 写代码前先想分层：功能层是原子砖块，永不绑定具体业务。',
    '- 排查问题先 cog_trace：看实际流转与耗时，再动手改。',
    '- 复盘 AI 行为用 cog_agent：看工具调用、幽灵路径、失败根源。',
    '- 日志缺失用 cog_instrument：dryRun 预览后确认注入，可回滚。',
  ].join('\n')
  return { status: 'ok', data: { guide: text } }
}

/** 导出供装配层复用。 */
export type { AgentTraceBuffer, LogPoint }

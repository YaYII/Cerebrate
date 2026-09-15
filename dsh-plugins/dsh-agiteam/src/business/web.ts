/**
 * dsh-agiteam Web 数据面 —— UI 面板与内核之间的唯一 HTTP 通道。
 *
 * 借鉴 pipeline-kernel 的 web.js：UI 只管显示，功能内核实现，
 * 本模块是 UI ↔ 内核的 HTTP 面。
 *
 * 路由：
 *   GET  /plugins/agiteam/state          → 项目/追溯矩阵/审计/校验快照
 *   POST /plugins/agiteam/audit          → 记录一条审计动作（供角色 agent 上报）
 *   POST /plugins/agiteam/verify         → 触发多层校验并返回结果
 *
 * 为什么独立成模块：web 面是业务编排的一部分（组合 features 纯能力
 * + webServer 服务），集中在这里，装配层只做注册。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { EngineRuntime, AgiteamConfig } from './engine'
import { loadState } from './engine'
import type { TeamRole } from './roles'
import { ROLE_NAMES } from './roles'
import { buildTraceRows, traceAllPassed } from '../features/trace'
import { verifyProject } from '../features/verify'
import { parseAuditLog, makeAuditEntry } from '../features/audit'
import { sha256Hex } from '../features/audit'
import type {
  TraceState,
  RequirementItem,
  FeatureItem,
  TestCase,
  UnitTestItem,
  CodeFileItem,
  AcceptanceScriptItem,
} from '../features/model'

/** 项目状态文件名（与 engine 一致）。 */
const AUDIT_FILE = 'audit.jsonl'

/** 读取请求体（JSON）。 */
function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}

/** JSON 响应助手。 */
function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * 构建一个项目的完整追溯快照（面板数据源）。
 * @returns TraceState 或 null（项目不存在）。
 */
export async function buildTraceSnapshot(
  rt: EngineRuntime,
  projectId: string,
): Promise<TraceState | null> {
  const state = await loadState(rt, projectId)
  if (!state) return null

  // 读取追溯实体（从产物 md 解析 —— 由角色 agent 写入，此处尽力读取）
  // 需求清单
  const reqText = state.artifacts.requirements ? await rt.readText(`${projectId}/${state.artifacts.requirements}`) : undefined
  const featuresText = state.artifacts.features ? await rt.readText(`${projectId}/${state.artifacts.features}`) : undefined
  const testcasesText = state.artifacts.testcases ? await rt.readText(`${projectId}/${state.artifacts.testcases}`) : undefined

  // 简化：从 state.json 的 artifacts 映射读取文本，暂不解析结构化实体（v2 阶段由审计动作填充）
  // 追溯矩阵：基于已登记的审计动作 + 产物存在性构建
  const auditText = await rt.readText(`${projectId}/${AUDIT_FILE}`)
  const auditEntries = auditText ? parseAuditLog(auditText) : []

  // 从审计动作还原追溯实体（action=register-* 携带实体数据）
  const requirements = extractFromAudit<{ id: string; title: string }>(auditEntries, 'register-requirement', 'detail')
    .map((d, i) => ({ id: d.id ?? `R-${i + 1}`, title: d.title ?? `需求 ${i + 1}`, detail: '', priority: 'P1' as const, acceptance: '' }))
  const features = extractFromAudit<{ id: string; name: string; requirementIds?: string[] }>(auditEntries, 'register-feature', 'detail')
    .map((d, i) => ({ id: d.id ?? `F-${i + 1}`, name: d.name ?? `功能 ${i + 1}`, requirementIds: d.requirementIds ?? [], description: '', userFlow: '' }))
  const testcases = extractFromAudit<{ id: string; featureId: string; title: string }>(auditEntries, 'register-testcase', 'detail')
    .map((d, i) => ({ id: d.id ?? `TC-${i + 1}`, featureId: d.featureId ?? '', title: d.title ?? `用例 ${i + 1}`, preconditions: '', steps: [], expected: '', kind: 'api' as const }))
  const unitTests = extractFromAudit<{ id: string; testCaseId: string; title: string; filePath: string; status: string }>(auditEntries, 'register-unittest', 'detail')
    .map((d, i) => ({ id: d.id ?? `UT-${i + 1}`, testCaseId: d.testCaseId ?? '', title: d.title ?? `单测 ${i + 1}`, filePath: d.filePath ?? '', status: (d.status === 'passed' ? 'passed' : 'pending') as 'passed' | 'pending' }))
  const codeFiles = extractFromAudit<{ id: string; featureId: string; path: string }>(auditEntries, 'register-codefile', 'detail')
    .map((d, i) => ({ id: d.id ?? `CF-${i + 1}`, featureId: d.featureId ?? '', path: d.path ?? '', sha256: sha256Hex(d.path ?? ''), updatedAt: Date.now(), lines: 0 }))
  // 验收脚本：按 id 取最新登记（同一脚本多次执行 → 覆盖为最近一次）
  const scriptRaw = extractFromAudit<{ id: string; featureId: string; path: string; kind: string; status: string; logFile?: string; ranAt?: number; exitCode?: number | null }>(auditEntries, 'register-script', 'detail')
  const scriptById = new Map<string, typeof scriptRaw[number]>()
  for (const d of scriptRaw) {
    const key = d.id ?? ''
    // 有 ranAt 的执行记录优先；无则登记；同 id 保留后者（按审计顺序，后者更新）
    scriptById.set(key, d)
  }
  const acceptanceScripts = [...scriptById.values()]
    .map((d, i) => ({ id: d.id ?? `AS-${i + 1}`, featureId: d.featureId ?? '', path: d.path ?? '', kind: (d.kind === 'api' || d.kind === 'ui' ? d.kind : 'script') as 'api' | 'ui' | 'script', status: (d.status === 'passed' ? 'passed' : 'pending') as 'passed' | 'pending', ...(d.logFile ? { logFile: d.logFile } : {}), ...(d.ranAt ? { ranAt: d.ranAt } : {}), ...(d.exitCode !== undefined && d.exitCode !== null ? { exitCode: d.exitCode } : {}) }))

  // 追溯矩阵
  const traceRows = buildTraceRows(requirements, features, testcases, unitTests, codeFiles, acceptanceScripts)

  // 多层校验
  const verification = await verifyProject(
    requirements, features, testcases, unitTests, codeFiles, acceptanceScripts, auditEntries,
    async (path) => rt.exists(path),
    async (path) => (await rt.readText(path)) !== undefined,
  )

  return {
    projectId: state.projectId,
    projectName: state.projectName,
    stage: state.stage,
    requirements,
    features,
    testcases,
    unitTests,
    codeFiles,
    acceptanceScripts,
    traceRows,
    auditLog: auditEntries.slice(-200),
    verification: {
      mathPass: verification.mathPass,
      scriptPass: verification.scriptPass,
      logPass: verification.logPass,
      details: verification.details,
    },
    reviewComments: state.reviewComments,
    updatedAt: state.updatedAt,
  }
}

/** 从审计动作 detail 提取 JSON 实体（宽容解析：坏行跳过）。 */
function extractFromAudit<T>(entries: { action: string; detail: string }[], action: string, _field: string): T[] {
  const out: T[] = []
  for (const e of entries) {
    if (e.action !== action) continue
    try {
      out.push(JSON.parse(e.detail) as T)
    } catch { /* 非 JSON detail 跳过 */ }
  }
  return out
}

/**
 * 注册 web 路由（懒注册：webServer 服务晚加载时正常注册，
 * 无 webServer 的 headless 环境仍可启动内核）。
 */
export function registerWebSurface(ctx: Context, config: AgiteamConfig, getRuntime: () => EngineRuntime): void {
  // webServer 是宿主服务，inject 回调的 ctx 参数才是注入后的上下文（pipeline-kernel 同款写法）
  ctx.inject(['webServer'], (injectedCtx) => {
    const webCtx = injectedCtx as Context & { webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
    } }
    const webServer = webCtx.webServer

    // S1：状态快照
    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/agiteam/state',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://x')
          const projectId = url.searchParams.get('project') ?? ''
          const rt = getRuntime()
          if (projectId) {
            // 优先数据库快照（storageDomain），失败回退文件系统
            let snapshot: TraceState | null = null
            try {
              snapshot = await buildDbSnapshot(webCtx, projectId)
            } catch {
              snapshot = null
            }
            if (!snapshot) snapshot = await buildTraceSnapshot(rt, projectId)
            if (!snapshot) return json(res, 404, { error: `项目 ${projectId} 不存在` })
            return json(res, 200, snapshot)
          }
          // 无 project → 列出所有项目（优先数据库，回退目录）
          let projects: Array<{ projectId: string; projectName: string; stage: string }> = []
          try {
            projects = await listDbProjects(webCtx)
          } catch {
            projects = []
          }
          if (projects.length === 0) {
            const dirs = await rt.listDir('')
            for (const dir of dirs) {
              const state = await loadState(rt, dir)
              if (state) projects.push({ projectId: state.projectId, projectName: state.projectName, stage: state.stage })
            }
          }
          return json(res, 200, { projects })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return json(res, 500, { error: msg })
        }
      },
    }), 'dsh-agiteam: state route')

    // S2：记录审计动作（角色 agent 上报：登记实体/执行结果）
    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/agiteam/audit',
      handler: async (req, res) => {
        const body = await readBody(req)
        let payload: { projectId: string; role: string; stage: string; action: string; detail: string; fingerprint?: string }
        try {
          payload = JSON.parse(body)
        } catch {
          return json(res, 400, { error: '请求体必须是 JSON' })
        }
        if (!payload.projectId || !payload.action || !payload.role) {
          return json(res, 400, { error: 'projectId/action/role 必填' })
        }
        try {
          const rt = getRuntime()
          // 读取现有审计，追加新条目
          const auditText = await rt.readText(`${payload.projectId}/${AUDIT_FILE}`)
          const entries = auditText ? parseAuditLog(auditText) : []
          const prevHash = entries.length > 0 ? entries[entries.length - 1]!.hash : 'GENESIS'
          const entry = makeAuditEntry(entries.length + 1, {
            time: Date.now(),
            action: payload.action,
            role: payload.role,
            projectId: payload.projectId,
            stage: payload.stage ?? '',
            detail: payload.detail,
            ...(payload.fingerprint ? { fingerprint: payload.fingerprint } : {}),
          }, prevHash)
          const nextText = auditText ? `${auditText}\n${JSON.stringify(entry)}` : JSON.stringify(entry)
          await rt.writeText(`${payload.projectId}/${AUDIT_FILE}`, nextText)
          return json(res, 200, { ok: true, seq: entry.seq, hash: entry.hash })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return json(res, 500, { error: msg })
        }
      },
    }), 'dsh-agiteam: audit route')

    // S3：触发多层校验
    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/agiteam/verify',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://x')
          const projectId = url.searchParams.get('project') ?? ''
          if (!projectId) return json(res, 400, { error: 'project 必填' })
          const rt = getRuntime()
          const snapshot = await buildTraceSnapshot(rt, projectId)
          if (!snapshot) return json(res, 404, { error: `项目 ${projectId} 不存在` })
          return json(res, 200, { verification: snapshot.verification, traceAllPassed: traceAllPassed(snapshot.traceRows) })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return json(res, 500, { error: msg })
        }
      },
    }), 'dsh-agiteam: verify route')

    // S4：任务板快照（面板任务板视图数据源）
    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/agiteam/tasks',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://x')
          const projectId = url.searchParams.get('project') ?? ''
          if (!projectId) return json(res, 400, { error: 'project 必填' })
          const snapshot = await buildBoardSnapshot(webCtx, projectId)
          if (!snapshot) return json(res, 404, { error: `项目 ${projectId} 不存在` })
          return json(res, 200, snapshot)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return json(res, 500, { error: msg })
        }
      },
    }), 'dsh-agiteam: tasks route')
  })
}

/**
 * 从数据库构建项目追溯快照（面板数据源，替代文件系统）。
 * @returns TraceState 或 null（项目不存在）。
 */
export async function buildDbSnapshot(
  ctx: Context,
  projectId: string,
): Promise<TraceState | null> {
  const { openAgiteamDomain, getProject, listEntities, listAudit } = await import('./store')
  const domain = await openAgiteamDomain(ctx)
  const project = getProject(domain, projectId)
  if (!project) return null

  // 从实体表还原追溯实体
  const requirements = listEntities(domain, projectId, 'requirement')
    .map(e => JSON.parse(e.data) as RequirementItem)
  const features = listEntities(domain, projectId, 'feature')
    .map(e => JSON.parse(e.data) as FeatureItem)
  const testcases = listEntities(domain, projectId, 'testcase')
    .map(e => JSON.parse(e.data) as TestCase)
  const unitTests = listEntities(domain, projectId, 'unittest')
    .map(e => JSON.parse(e.data) as UnitTestItem)
  const codeFiles = listEntities(domain, projectId, 'codefile')
    .map(e => JSON.parse(e.data) as CodeFileItem)
  const acceptanceScripts = listEntities(domain, projectId, 'script')
    .map(e => JSON.parse(e.data) as AcceptanceScriptItem)

  // 审计日志（数据库）
  const auditEntries = listAudit(domain, projectId, 200)
    .map(a => ({
      seq: a.seq,
      time: a.time,
      action: a.action,
      role: a.role,
      projectId: a.projectId,
      stage: a.stage,
      detail: a.detail,
      ...(a.fingerprint ? { fingerprint: a.fingerprint } : {}),
      prevHash: a.prevHash,
      hash: a.hash,
    }))

  // 追溯矩阵
  const traceRows = buildTraceRows(requirements, features, testcases, unitTests, codeFiles, acceptanceScripts)

  // 多层校验（实体状态已含 ranAt/status，脚本文件检查用 fs）
  const verification = await verifyProject(
    requirements, features, testcases, unitTests, codeFiles, acceptanceScripts, auditEntries,
    async (path) => { try { return await rtExists(ctx, project.cwd, path) } catch { return false } },
    async (path) => { try { return (await rtRead(ctx, project.cwd, path)) !== undefined } catch { return false } },
  )

  return {
    projectId: project.id,
    projectName: project.name,
    stage: project.stage,
    requirements,
    features,
    testcases,
    unitTests,
    codeFiles,
    acceptanceScripts,
    traceRows,
    auditLog: auditEntries,
    verification: {
      mathPass: verification.mathPass,
      scriptPass: verification.scriptPass,
      logPass: verification.logPass,
      details: verification.details,
    },
    reviewComments: project.reviewComments,
    updatedAt: project.updatedAt,
  }
}

/** 读取项目 cwd 下相对路径的文件（用于脚本层校验）。dsh-fs 契约：resolve → readText(target)。 */
async function rtRead(ctx: Context, cwd: string, rel: string): Promise<string | undefined> {
  const fs = ctx.get('fs') as {
    resolve(path: string): Promise<{ targetKey: string; displayPath: string }>
    readText(target: { targetKey: string; displayPath: string }): Promise<string>
  } | undefined
  if (!fs) return undefined
  try {
    const target = await fs.resolve(`${cwd.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`)
    return await fs.readText(target)
  } catch { return undefined }
}

/** 判断项目 cwd 下相对路径是否存在。 */
async function rtExists(ctx: Context, cwd: string, rel: string): Promise<boolean> {
  const fs = ctx.get('fs') as {
    resolve(path: string): Promise<{ targetKey: string; displayPath: string }>
    stat(target: { targetKey: string; displayPath: string }): Promise<unknown>
  } | undefined
  if (!fs) return false
  try {
    const target = await fs.resolve(`${cwd.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`)
    return (await fs.stat(target)) !== undefined
  } catch { return false }
}

/** 列出数据库中的全部项目（面板项目列表）。 */
export async function listDbProjects(ctx: Context): Promise<Array<{ projectId: string; projectName: string; stage: string }>> {
  const { openAgiteamDomain, listProjects } = await import('./store')
  const domain = await openAgiteamDomain(ctx)
  return listProjects(domain).map(p => ({ projectId: p.id, projectName: p.name, stage: p.stage }))
}

/** 任务板条目（面板数据源）。 */
export interface BoardTaskView {
  id: string
  stage: string
  title: string
  role: string
  status: string
  sessionId: string
  approvalSuggestion: string
  reviewComment: string
  pausedByHuman: boolean
  pauseReason: string
  result: string
  updatedAt: number
}

/** 从数据库构建任务板快照（面板数据源）。 */
export async function buildBoardSnapshot(
  ctx: Context,
  projectId: string,
): Promise<{ projectId: string; projectName: string; stage: string; tasks: BoardTaskView[] } | null> {
  const { openAgiteamDomain, getProject, listTasks } = await import('./store')
  const domain = await openAgiteamDomain(ctx)
  const project = getProject(domain, projectId)
  if (!project) return null
  const tasks = listTasks(domain, projectId).map(t => ({
    id: t.id,
    stage: t.stage,
    title: t.title,
    role: t.role,
    status: t.status,
    sessionId: t.sessionId,
    approvalSuggestion: t.approvalSuggestion,
    reviewComment: t.reviewComment,
    pausedByHuman: t.pausedByHuman,
    pauseReason: t.pauseReason,
    result: t.result,
    updatedAt: t.updatedAt,
  }))
  return { projectId: project.id, projectName: project.name, stage: project.stage, tasks }
}

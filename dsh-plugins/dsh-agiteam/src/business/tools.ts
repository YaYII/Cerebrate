/**
 * agiteam_* 工具的顶层 execute —— 业务编排入口。
 *
 * 每个 execute 是顶层导出函数（可独立单元测试），装配层只做
 * defineTool 包装与注册。所有错误路径返回中文可操作消息。
 * 返回值统一为可 JSON 序列化的对象（与工具 output schema 一致）。
 */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { StageId } from '../features/stage'
import { STAGE_NAMES } from '../features/stage'
import type { ProjectRecordType } from './domain'
import {
  advanceAndWake,
  loadState,
  runtimeFromCtx,
  startProject,
  type AgiteamConfig,
  type EngineRuntime,
} from './engine'
import type { TeamRole } from './roles'
import { ROLE_NAMES } from './roles'

/** 可 JSON 序列化的值（与 dsh-tools 的 JsonValue 同构，避免额外依赖）。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 工具返回值形状（可 JSON 序列化，兼容 defineTool 的 execute 契约）。 */
export type ToolResult = Record<string, JsonValue>

/** 错误结果。 */
function errorResult(message: string): ToolResult {
  return { status: 'error', message }
}

/** 从工具执行上下文构造引擎运行时与项目 cwd。 */
export function buildRuntime(ctx: Context, config: AgiteamConfig, cwd?: string): { rt: EngineRuntime; cwd: string } {
  const projectCwd = cwd ?? process.cwd()
  return { rt: runtimeFromCtx(ctx, projectCwd), cwd: projectCwd }
}

/** 启动团队开发项目（agiteam_start）—— 数据库版（storageDomain），自动唤醒需求分析师开始第一阶段。 */
export async function executeStartProject(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectName: string; requirement: string; projectId?: string; cwd?: string; kbPath?: string },
): Promise<ToolResult> {
  const projectId = args.projectId ?? safeId(args.projectName)
  const cwd = args.cwd ?? process.cwd()
  try {
    // taskboard 底座版：项目/任务/审批全部走 taskboard SQLite
    const { tbProjectExists, tbProjectKey } = await import('./agiteam-tb')
    const { agiteamStartFlow } = await import('./agiteam-flow')
    if (tbProjectExists(projectId)) {
      return errorResult(`项目 ${projectId} 已存在（key=${tbProjectKey(projectId)}，先查询 agiteam_status 或用其他 projectId）`)
    }
    // 创建工程根目录 + 功能子目录（像真实工程）
    const rootDir = args.cwd ? `${args.cwd.replace(/\/+$/, '')}/${projectId}` : `${process.cwd().replace(/\/+$/, '')}/${projectId}`
    const subDirs = ['requirements', 'features', 'testcases', 'code', 'tests', 'scripts', 'docs']
    try {
      await mkdir(rootDir, { recursive: true })
      for (const sub of subDirs) {
        await mkdir(`${rootDir}/${sub}`, { recursive: true }).catch(() => { /* 已存在忽略 */ })
      }
    } catch { /* 目录创建失败不阻断（角色写产物时会再尝试） */ }

    // 启动 AGI 团队流程（taskboard 项目 + 第一阶段任务 + 需求分析师 agent）
    const result = await agiteamStartFlow(
      ctx,
      projectId,
      args.projectName,
      args.requirement,
      undefined,
      args.kbPath,
    )
    return {
      status: 'ok',
      message: `团队开发项目「${args.projectName}」已启动（id: ${projectId}，taskboard 项目 key: ${result.project.key as string}），当前阶段：需求分析。需求分析师已自动唤醒。${args.kbPath ? `产物将按规范自动落盘团队知识库：${args.kbPath}` : '（未指定 kbPath，产物仅存工程目录）'}`,
      projectId,
      stage: 'requirement',
      rootDir,
      taskboardKey: result.project.key,
      task: (result.task as { identifier: string }).identifier,
      ...(args.kbPath ? { kbPath: args.kbPath } : {}),
    }
  } catch (err) {
    // taskboard 不可用（未注册/版本不符）→ 回退旧 engine（文件系统 + storageDomain）
    const original = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    try {
      const { openAgiteamDomain, upsertProject, getProject } = await import('./store')
      const { autoDriveRuntimeFromCtx, ensureStageTask } = await import('./auto-drive')
      const domain = await openAgiteamDomain(ctx)
      if (getProject(domain, projectId)) {
        return errorResult(`项目 ${projectId} 已存在（先查询 agiteam_status 或用其他 projectId）`)
      }
      const now = Date.now()
      const rootDir = args.cwd ? `${args.cwd.replace(/\/+$/, '')}/${projectId}` : `${process.cwd().replace(/\/+$/, '')}/${projectId}`
      const agentSelf = (ctx as { agent?: { session?: { id?: string }; options?: { provider?: string; model?: string; reasoningEffort?: string } } }).agent
      const project = {
        id: projectId,
        name: args.projectName,
        rawRequirement: args.requirement,
        stage: 'requirement',
        completed: {},
        reviewComments: {},
        artifacts: {},
        cwd: rootDir,
        autoDrive: true,
        currentReqId: '',
        requirements: {},
        ownerSession: agentSelf?.session?.id ?? '',
        kbPath: args.kbPath ?? '',
        ownerProvider: agentSelf?.options?.provider ?? '',
        ownerModel: agentSelf?.options?.model ?? '',
        ownerEffort: agentSelf?.options?.reasoningEffort ?? '',
        createdAt: now,
        updatedAt: now,
      }
      await upsertProject(domain, project)
      await ensureStageTask(domain, project, 'requirement')
      const rt = autoDriveRuntimeFromCtx(ctx, rootDir)
      const { stageGreeting, wakeStageRole } = await import('./auto-drive')
      const greeting = stageGreeting(project, 'requirement', args.requirement)
      await wakeStageRole(domain, rt, project, 'requirement', greeting)
      return {
        status: 'ok',
        message: `团队开发项目「${args.projectName}」已启动（id: ${projectId}，回退模式），当前阶段：需求分析。`,
        projectId,
        stage: 'requirement',
        rootDir,
        fallback: true,
      }
    } catch (fallbackErr) {
      // 第三层兜底：文件系统模式（engine.startProject）
      try {
        const { rt } = buildRuntime(ctx, config, args.cwd)
        const state = await startProject(rt, projectId, args.projectName, args.requirement, cwd)
        return {
          status: 'ok',
          message: `团队开发项目「${args.projectName}」已启动（id: ${projectId}，文件系统模式），当前阶段：${STAGE_NAMES.requirement}。`,
          projectId,
          stage: state.stage,
          fallback: true,
        }
      } catch (fileErr) {
        const fileDetail = fileErr instanceof Error ? `${fileErr.message}\n${fileErr.stack ?? ''}` : String(fileErr)
        const fbDetail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        return errorResult(`项目启动失败（taskboard 路径：${original}\nstorageDomain 路径：${fbDetail}\n文件系统路径：${fileDetail}）`)
      }
    }
  }
}

/** 查询项目状态（agiteam_status）—— taskboard 底座优先，回退 storageDomain。 */
export async function executeStatus(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; cwd?: string },
): Promise<ToolResult> {
  // taskboard 底座版：读 taskboard 项目全景
  try {
    const { tbProjectExists, tbProjectKey, tbProvider } = await import('./agiteam-tb')
    const { agiteamProjectView } = await import('./agiteam-flow')
    if (tbProjectExists(args.projectId)) {
      const provider = tbProvider() as { getProject(k: string): { name: string } }
      const view = agiteamProjectView(args.projectId)
      return {
        status: 'ok',
        projectId: args.projectId,
        projectName: provider.getProject(tbProjectKey(args.projectId)).name,
        stage: view.stage,
        stageName: STAGE_NAMES[view.stage as StageId] ?? view.stage,
        ...(view.currentTask ? {
          currentTask: {
            id: view.currentTask.id,
            title: view.currentTask.title,
            status: view.currentTask.status,
            ...(view.currentTask.stage ? { stage: view.currentTask.stage } : {}),
            version: view.currentTask.version,
          },
        } : {}),
        tasks: view.tasks.map(t => ({
          id: t.id,
          identifier: t.identifier,
          title: t.title,
          status: t.status,
          ...(t.stage ? { stage: t.stage } : {}),
          version: t.version,
          createdAt: t.createdAt,
        })),
        taskboard: true,
      }
    }
  } catch { /* taskboard 不可用 → 回退 */ }
  try {
    const { openAgiteamDomain, getProject, listTasks, listEntities, listAudit } = await import('./store')
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const tasks = listTasks(domain, args.projectId)
    const entities = listEntities(domain, args.projectId)
    const audit = listAudit(domain, args.projectId, 50)
    const completed = Object.entries(project.completed).filter(([, v]) => v).map(([k]) => STAGE_NAMES[k as StageId] ?? k)
    return {
      status: 'ok',
      projectId: project.id,
      projectName: project.name,
      stage: project.stage,
      stageName: STAGE_NAMES[project.stage as StageId] ?? project.stage,
      completed,
      reviewComments: project.reviewComments,
      currentReqId: project.currentReqId,
      requirements: Object.keys(project.requirements),
      tasks: tasks.map(t => ({ id: t.id, stage: t.stage, title: t.title, role: t.role, status: t.status })),
      entityCount: entities.length,
      auditCount: audit.length,
    }
  } catch (err) {
    // storageDomain 不可用 → 回退旧 engine（文件系统）
    const { rt } = buildRuntime(ctx, config, args.cwd)
    const state = await loadState(rt, args.projectId)
    if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    return {
      status: 'ok',
      projectId: state.projectId,
      projectName: state.projectName,
      stage: state.stage,
      stageName: STAGE_NAMES[state.stage as StageId] ?? state.stage,
      completed: Object.entries(state.completed).filter(([, v]) => v).map(([k]) => STAGE_NAMES[k as StageId] ?? k),
      reviewComments: state.reviewComments,
      artifacts: state.artifacts,
    }
  }
}

/** 推进阶段（agiteam_advance：通过 或 打回）—— DB 版。 */
export async function executeAdvance(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; passed: boolean; comment?: string; cwd?: string },
): Promise<ToolResult> {
  try {
    const { openAgiteamDomain, getProject } = await import('./store')
    const { autoDriveRuntimeFromCtx, autoAdvance, reviewDecision } = await import('./auto-drive')
    const { isReviewStage } = await import('../features/stage')
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const before = project.stage
    // 角色会话 cwd 必须用项目 cwd（避免 sessionId 跨 cwd 持久化冲突）
    const rt = autoDriveRuntimeFromCtx(ctx, args.cwd ?? project.cwd)
    let updated: ProjectRecordType
    if (isReviewStage(before as StageId)) {
      // 评审阶段：passed=true 前进，passed=false 打回上一阶段
      updated = await reviewDecision(ctx, domain, rt, args.projectId, args.passed, args.comment ?? '')
    } else {
      // 普通阶段：仅 passed=true 才推进（打回无意义）
      if (!args.passed) return errorResult(`当前阶段「${STAGE_NAMES[before as StageId] ?? before}」不是评审阶段，只能通过推进`)
      updated = await autoAdvance(ctx, domain, rt, args.projectId, args.comment ?? '阶段推进')
    }
    const verb = args.passed ? '通过' : '打回'
    return {
      status: 'ok',
      message: `阶段「${STAGE_NAMES[before as StageId] ?? before}」${verb}，当前阶段：${STAGE_NAMES[updated.stage as StageId] ?? updated.stage}。`,
      from: before,
      to: updated.stage,
      passed: args.passed,
    }
  } catch (err) {
    const { rt } = buildRuntime(ctx, config, args.cwd)
    const state = await loadState(rt, args.projectId)
    if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const before = state.stage
    const next = await advanceAndWake(rt, state, args.passed, args.comment)
    const verb = args.passed ? '通过' : '打回'
    return {
      status: 'ok',
      message: `阶段「${STAGE_NAMES[before as StageId] ?? before}」${verb}，当前阶段：${STAGE_NAMES[next.stage as StageId] ?? next.stage}。`,
      from: before,
      to: next.stage,
      passed: args.passed,
    }
  }
}

/** 让指定角色 agent 执行一个任务（agiteam_task：分派工作给角色）—— DB 版。 */
export async function executeRoleTask(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; role: TeamRole; task: string; cwd?: string },
): Promise<ToolResult> {
  try {
    const { openAgiteamDomain, getProject } = await import('./store')
    const { autoDriveRuntimeFromCtx } = await import('./auto-drive')
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const roleName = ROLE_NAMES[args.role] ?? args.role
    const text = [
      `【dsh-agiteam】项目「${project.name}」分派任务给 ${roleName}：`,
      '',
      args.task,
    ].join('\n')
    // 角色会话 cwd 必须是项目 cwd（否则同一 sessionId 在不同 cwd 持久化会 id 冲突）
    const roleCwd = args.cwd ?? project.cwd
    const rt = autoDriveRuntimeFromCtx(ctx, roleCwd)
    try {
      // taskboard 模式：ensureRole 随机 id + resume 续接（无固定 sessionId 冲突）
      await rt.ensureRole(args.projectId, args.role, roleCwd, text, project.currentReqId || undefined, { provider: project.ownerProvider, model: project.ownerModel, effort: project.ownerEffort })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return errorResult(`分派任务给 ${roleName} 失败：角色启动失败（${detail}）。请检查角色 preset/模型配置后重试。`)
    }
    return {
      status: 'ok',
      message: `已分派任务给 ${roleName}（${args.role}）。`,
      role: args.role,
    }
  } catch (err) {
    // 回退旧 engine
    const { rt, cwd } = buildRuntime(ctx, config, args.cwd)
    const state = await loadState(rt, args.projectId)
    if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const roleName = ROLE_NAMES[args.role] ?? args.role
    const text = [
      `【dsh-agiteam】项目「${state.projectName}」分派任务给 ${roleName}：`,
      '',
      args.task,
    ].join('\n')
    const woken = await rt.wakeRoleAgent(state.projectId, args.role, text)
    if (!woken) {
      await rt.createRoleAgent(state.projectId, args.role, cwd, text)
    }
    return {
      status: 'ok',
      message: `已分派任务给 ${roleName}（${args.role}）。`,
      role: args.role,
      woken,
    }
  }
}

/** 列出/读取阶段产物（agiteam_artifact：查看需求清单/功能清单/用例矩阵/验收报告）—— DB 版。 */
export async function executeReadArtifact(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; artifact: string; cwd?: string },
): Promise<ToolResult> {
  try {
    const { openAgiteamDomain, getProject } = await import('./store')
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    // DB 版产物路径：项目 cwd 下按阶段固定文件名（需求/功能/用例/验收报告）
    const artifactFiles: Record<string, string> = {
      requirements: 'requirements/requirements.md',
      features: 'features/features.md',
      testcases: 'testcases/testcases.md',
      acceptance: 'acceptance.md',
      e2e: 'e2e.md',
    }
    const rel = artifactFiles[args.artifact]
    if (!rel) return errorResult(`未知产物类型 ${args.artifact}（可选：requirements/features/testcases/acceptance/e2e）`)
    const { rt } = buildRuntime(ctx, config, args.cwd)
    const text = await rt.readText(`${project.cwd.replace(/\/+$/, '')}/${rel}`)
    if (!text) return errorResult(`产物 ${args.artifact} 尚不存在或内容为空`)
    return { status: 'ok', artifact: args.artifact, content: text }
  } catch (err) {
    // 回退旧 engine
    const { rt } = buildRuntime(ctx, config, args.cwd)
    const state = await loadState(rt, args.projectId)
    if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const file = state.artifacts[args.artifact]
    if (!file) return errorResult(`产物 ${args.artifact} 尚不存在`)
    const text = await rt.readText(`${state.projectId}/${file}`)
    if (!text) return errorResult(`产物 ${args.artifact} 内容为空`)
    return { status: 'ok', artifact: args.artifact, content: text }
  }
}

/** 把中文项目名安全化为目录/会话 id。 */
export function safeId(name: string): string {
  const normalized = name.trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `project-${Date.now().toString(36)}`
}

/**
 * 登记追溯实体（agiteam_register）—— 角色 agent 每完成一个实体
 * （需求/功能/用例/单测/代码/脚本）后调用，写入审计日志（带指纹），
 * 成为追溯矩阵与多层校验的数据源。
 *
 * action 取值：
 *  - register-requirement   需求条目（detail: {id, title, priority}）
 *  - register-feature      功能条目（detail: {id, name, requirementIds}）
 *  - register-testcase     用例条目（detail: {id, featureId, title, kind}）
 *  - register-unittest     单测条目（detail: {id, testCaseId, title, filePath, status}）
 *  - register-codefile     代码文件（detail: {id, featureId, path}）
 *  - register-script       验收脚本（detail: {id, featureId, path, kind}）
 */
export async function executeRegister(
  ctx: Context,
  config: AgiteamConfig,
  args: {
    projectId: string
    role: string
    stage: string
    action: string
    detail: string
    fingerprint?: string
    cwd?: string
  },
): Promise<ToolResult> {
  // 校验 action 合法
  const validActions = ['register-requirement', 'register-feature', 'register-testcase', 'register-unittest', 'register-codefile', 'register-script']
  if (!validActions.includes(args.action)) {
    return errorResult(`action 必须是：${validActions.join('/')}`)
  }
  // detail 必须是合法 JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(args.detail)
  } catch {
    return errorResult('detail 必须是合法 JSON 字符串')
  }
  try {
    // 数据库版：写入 entities 表 + 审计表
    const { openAgiteamDomain, getProject, upsertEntity, appendAuditRecord, lastAudit } = await import('./store')
    const { makeAuditEntry } = await import('../features/audit')
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)

    // 实体类型映射（action → type）
    const typeMap: Record<string, string> = {
      'register-requirement': 'requirement',
      'register-feature': 'feature',
      'register-testcase': 'testcase',
      'register-unittest': 'unittest',
      'register-codefile': 'codefile',
      'register-script': 'script',
    }
    const type = typeMap[args.action]!
    const entity = parsed as { id?: string }
    const entityId = entity.id ?? `${type}-${Date.now().toString(36)}`
    // 提取关联关系（featureId/requirementIds/testCaseId）
    const refs: Record<string, string | string[]> = {}
    const p = parsed as Record<string, unknown>
    if (typeof p.featureId === 'string') refs.featureId = p.featureId
    if (typeof p.testCaseId === 'string') refs.testCaseId = p.testCaseId
    if (Array.isArray(p.requirementIds)) refs.requirementIds = p.requirementIds as string[]
    const now = Date.now()
    await upsertEntity(domain, {
      id: entityId,
      type: type as 'requirement',
      projectId: args.projectId,
      data: args.detail,
      refs,
      status: (p.status === 'passed' ? 'passed' : 'pending') as 'passed',
      createdAt: now,
      updatedAt: now,
    })

    // 审计
    const prev = lastAudit(domain, args.projectId)
    const entry = makeAuditEntry(prev ? prev.seq + 1 : 1, {
      time: now,
      action: args.action,
      role: args.role,
      projectId: args.projectId,
      stage: args.stage,
      detail: args.detail,
    }, prev ? prev.hash : 'GENESIS')
    await appendAuditRecord(domain, entry)

    return {
      status: 'ok',
      message: `已登记 ${args.action}（${entityId}），进入数据库与审计日志。`,
      seq: entry.seq,
      hash: entry.hash,
      entityId,
    }
  } catch (err) {
    // 数据库不可用 → 回退旧 engine（文件系统审计）
    const { rt } = buildRuntime(ctx, config, args.cwd)
    const state = await loadState(rt, args.projectId)
    if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const result = await rt.appendAudit({
      projectId: args.projectId,
      role: args.role,
      stage: args.stage,
      action: args.action,
      detail: args.detail,
      ...(args.fingerprint ? { fingerprint: args.fingerprint } : {}),
    })
    return {
      status: 'ok',
      message: `已登记 ${args.action}（seq=${result.seq}，文件系统模式），进入审计日志。`,
      seq: result.seq,
      hash: result.hash,
    }
  }
}

/**
 * 执行验收脚本（agiteam_run_acceptance）—— 测试验收员运行真实命令，
 * 记录运行日志文件 + 登记审计（脚本层/日志层证据）。
 */
export async function executeRunAcceptance(
  ctx: Context,
  config: AgiteamConfig,
  args: {
    projectId: string
    role: string
    stage: string
    scriptId: string
    featureId: string
    path: string
    kind: 'api' | 'ui' | 'script'
    command: string
    argsList?: string[]
    timeoutMs?: number
    cwd?: string
  },
): Promise<ToolResult> {
  const { rt, cwd } = buildRuntime(ctx, config, args.cwd)
  const state = await loadState(rt, args.projectId)
  if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
  if (!args.command) return errorResult('command 必填（要执行的命令）')

  // 1. 执行真实命令（runner.ts 有界输出 + 超时）
  const { runAcceptanceCommand } = await import('../features/runner')
  const run = await runAcceptanceCommand(args.command, args.argsList ?? [], {
    cwd,
    timeoutMs: args.timeoutMs ?? 120_000,
  })

  // 2. 记录运行日志到项目目录（脚本层/日志层证据）
  const logRel = `${args.projectId}/logs/${args.scriptId}-${Date.now()}.log`
  const logContent = [
    `# 验收脚本执行日志：${args.scriptId}`,
    `命令: ${args.command} ${(args.argsList ?? []).join(' ')}`,
    `工作目录: ${cwd}`,
    `退出码: ${run.exitCode}`,
    `耗时: ${run.durationMs}ms`,
    `超时: ${run.timedOut}`,
    '',
    '## stdout',
    run.stdout,
    '',
    '## stderr',
    run.stderr,
  ].join('\n')
  await rt.writeText(logRel, logContent)

  // 3. 登记审计（register-script + 执行结果）
  const passed = run.exitCode === 0 && !run.timedOut
  const scriptDetail = JSON.stringify({
    id: args.scriptId,
    featureId: args.featureId,
    path: args.path,
    kind: args.kind,
    status: passed ? 'passed' : 'failed',
    logFile: logRel,
    ranAt: Date.now(),
    exitCode: run.exitCode,
  })
  const result = await rt.appendAudit({
    projectId: args.projectId,
    role: args.role,
    stage: args.stage,
    action: 'register-script',
    detail: scriptDetail,
    fingerprint: run.exitCode === 0 ? run.stdout.slice(0, 64) : run.stderr.slice(0, 64),
  })

  return {
    status: 'ok',
    message: `验收脚本 ${args.scriptId} 执行${passed ? '通过' : '失败'}（退出码 ${run.exitCode}）。`,
    scriptId: args.scriptId,
    passed,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    logFile: logRel,
    outputTail: (passed ? run.stdout : run.stderr).slice(-2000),
    seq: result.seq,
    hash: result.hash,
  }
}

/**
 * 阶段完成自动推进（agiteam_done）—— 角色完成当前阶段任务后调用。
 * 任务进入 in_review 等待人工审批；你审批放行后才推进到下一阶段。
 */
export async function executeAutoDone(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; result: string; cwd?: string },
): Promise<ToolResult> {
  // taskboard 底座版：角色完成 → 当前 in_progress 任务提交 in_review
  try {
    const { tbProjectExists, tbCurrentStageTask, tbSubmitStageReview } = await import('./agiteam-tb')
    if (tbProjectExists(args.projectId)) {
      const current = tbCurrentStageTask(args.projectId)
      if (!current) return errorResult(`项目 ${args.projectId} 当前无进行中任务`)
      const submitted = tbSubmitStageReview(
        current.id as string, current.version as number, args.result, '阶段完成，等待审批',
      )
      return {
        status: 'ok',
        message: `任务「${current.title as string}」已完成，已提交审批（in_review）。请用 agiteam_approve 放行推进，或 agiteam_reject 打回。`,
        projectId: args.projectId,
        taskId: current.id as string,
        stage: (submitted as { status: string }).status,
        awaitingApproval: true,
      }
    }
  } catch { /* 回退旧逻辑 */ }
  const { openAgiteamDomain, getProject } = await import('./store')
  const { autoAdvance, autoDriveRuntimeFromCtx } = await import('./auto-drive')
  try {
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    // 角色会话 cwd 必须用项目 cwd（避免 sessionId 跨 cwd 持久化冲突）
    const rt = autoDriveRuntimeFromCtx(ctx, args.cwd ?? project?.cwd ?? process.cwd())
    const advanced = await autoAdvance(ctx, domain, rt, args.projectId, args.result)
    const stageName = STAGE_NAMES[advanced.stage as StageId] ?? advanced.stage
    return {
      status: 'ok',
      message: `阶段「${stageName}」已完成，任务已提交审批（in_review）。请用 agiteam_approve 放行推进，或 agiteam_reject 打回。`,
      projectId: advanced.id,
      stage: advanced.stage,
      stageName,
      awaitingApproval: true,
    }
  } catch (err) {
    return errorResult(`自动推进失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 人工审批放行（agiteam_approve）—— 只有你能审批放行。
 * in_review → done（taskboard accept），创建下阶段任务并唤醒下角色。
 */
export async function executeApprove(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; comment?: string; advance?: boolean; cwd?: string },
): Promise<ToolResult> {
  // taskboard 底座版
  try {
    const { tbProjectExists, tbCurrentStageTask, tbProjectStage } = await import('./agiteam-tb')
    const { agiteamApproveFlow } = await import('./agiteam-flow')
    if (tbProjectExists(args.projectId)) {
      const current = tbCurrentStageTask(args.projectId)
      if (!current) return errorResult(`项目 ${args.projectId} 当前无待审批任务`)
      const result = await agiteamApproveFlow(
        ctx, args.projectId, current.id as string, current.version as number,
        (current.title as string).split('·')[0]?.trim() ?? args.projectId,
        args.comment ?? '',
      )
      const stage = tbProjectStage(args.projectId)
      return {
        status: 'ok',
        message: `任务「${current.title as string}」已审批放行（done）。${result.nextStage ? `已创建下阶段任务：${result.nextStage}，角色已唤醒。` : '项目已交付。'}`,
        projectId: args.projectId,
        taskId: current.id as string,
        stage,
        ...(result.nextStage ? { nextStage: result.nextStage } : {}),
      }
    }
  } catch { /* 回退旧逻辑 */ }
  const { openAgiteamDomain, getProject } = await import('./store')
  const { approveStage, autoDriveRuntimeFromCtx } = await import('./auto-drive')
  try {
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const rt = autoDriveRuntimeFromCtx(ctx, args.cwd ?? project.cwd)
    const updated = await approveStage(ctx, domain, rt, args.projectId, args.comment ?? '', args.advance ?? true)
    const stageName = STAGE_NAMES[updated.stage as StageId] ?? updated.stage
    return {
      status: 'ok',
      message: `阶段已审批放行，当前阶段：${stageName}。`,
      projectId: updated.id,
      stage: updated.stage,
      stageName,
    }
  } catch (err) {
    return errorResult(`审批放行失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 人工打回（agiteam_reject）—— 只有你能打回。
 * in_review → todo（返工），带意见。
 */
export async function executeReject(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; comment: string; cwd?: string },
): Promise<ToolResult> {
  // taskboard 底座版
  try {
    const { tbProjectExists, tbCurrentStageTask } = await import('./agiteam-tb')
    const { agiteamRejectFlow } = await import('./agiteam-flow')
    if (tbProjectExists(args.projectId)) {
      const current = tbCurrentStageTask(args.projectId)
      if (!current) return errorResult(`项目 ${args.projectId} 当前无进行中任务`)
      const updated = agiteamRejectFlow(args.projectId, current.id as string, current.version as number, args.comment)
      return {
        status: 'ok',
        message: `任务「${updated.title as string}」已打回返工（${args.comment}）。`,
        projectId: args.projectId,
        taskId: current.id as string,
        stage: (updated as { status: string }).status,
      }
    }
  } catch { /* 回退旧逻辑 */ }
  const { openAgiteamDomain, getProject } = await import('./store')
  const { rejectStage, autoDriveRuntimeFromCtx } = await import('./auto-drive')
  try {
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const rt = autoDriveRuntimeFromCtx(ctx, args.cwd ?? project.cwd)
    const updated = await rejectStage(ctx, domain, rt, args.projectId, args.comment)
    const stageName = STAGE_NAMES[updated.stage as StageId] ?? updated.stage
    return {
      status: 'ok',
      message: `阶段已打回（${args.comment}），返回阶段：${stageName} 返工。`,
      projectId: updated.id,
      stage: updated.stage,
      stageName,
    }
  } catch (err) {
    return errorResult(`打回失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 人工暂停（agiteam_pause）—— 随时暂停当前阶段（你是魔王）。
 * 暂停的任务不会自动推进；恢复用 agiteam_resume。
 */
export async function executePause(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; reason: string; cwd?: string },
): Promise<ToolResult> {
  // taskboard 底座版
  try {
    const { tbProjectExists, tbCurrentStageTask } = await import('./agiteam-tb')
    const { agiteamPauseFlow } = await import('./agiteam-flow')
    if (tbProjectExists(args.projectId)) {
      const current = tbCurrentStageTask(args.projectId)
      if (!current) return errorResult(`项目 ${args.projectId} 当前无进行中任务`)
      await agiteamPauseFlow(args.projectId, current.id as string, current.version as number, args.reason)
      return {
        status: 'ok',
        message: `任务「${current.title as string}」已暂停（${args.reason}）。恢复用 agiteam_resume。`,
        projectId: args.projectId,
        taskId: current.id as string,
        paused: true,
      }
    }
  } catch { /* 回退旧逻辑 */ }
  const { openAgiteamDomain, getProject } = await import('./store')
  const { pauseStage } = await import('./auto-drive')
  try {
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    await pauseStage(ctx, domain, args.projectId, args.reason)
    return {
      status: 'ok',
      message: `阶段已暂停（${args.reason}）。恢复用 agiteam_resume。`,
      projectId: args.projectId,
      paused: true,
    }
  } catch (err) {
    return errorResult(`暂停失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 恢复暂停阶段（agiteam_resume）—— 恢复后继续当前阶段。
 */
export async function executeResume(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; cwd?: string },
): Promise<ToolResult> {
  // taskboard 底座版
  try {
    const { tbProjectExists, tbCurrentStageTask } = await import('./agiteam-tb')
    const { agiteamResumeFlow } = await import('./agiteam-flow')
    if (tbProjectExists(args.projectId)) {
      const current = tbCurrentStageTask(args.projectId)
      if (!current) return errorResult(`项目 ${args.projectId} 当前无暂停任务`)
      await agiteamResumeFlow(args.projectId, current.id as string, current.version as number)
      return {
        status: 'ok',
        message: `任务「${current.title as string}」已恢复。`,
        projectId: args.projectId,
        taskId: current.id as string,
        resumed: true,
      }
    }
  } catch { /* 回退旧逻辑 */ }
  const { openAgiteamDomain, getProject } = await import('./store')
  const { resumeStage, autoDriveRuntimeFromCtx } = await import('./auto-drive')
  try {
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const rt = autoDriveRuntimeFromCtx(ctx, args.cwd ?? project.cwd)
    await resumeStage(ctx, domain, rt, args.projectId)
    return {
      status: 'ok',
      message: '阶段已恢复，角色已唤醒继续。',
      projectId: args.projectId,
      resumed: true,
    }
  } catch (err) {
    return errorResult(`恢复失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * AI 代为审批（agiteam_ai_approve）—— AI 依据验收标准给出审批建议，
 * 提交到任务（in_review 或直接建议），但最终放行权在你。
 */
export async function executeAiApprove(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; suggestion: string; approve?: boolean; cwd?: string },
): Promise<ToolResult> {
  const { openAgiteamDomain, getProject } = await import('./store')
  const { aiApproveSuggestion } = await import('./auto-drive')
  try {
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    await aiApproveSuggestion(ctx, domain, args.projectId, args.suggestion, args.approve ?? true)
    return {
      status: 'ok',
      message: `AI 审批建议已提交：${args.approve ? '建议放行' : '建议打回'}（${args.suggestion}）。最终决定权在你：agiteam_approve / agiteam_reject。`,
      projectId: args.projectId,
      suggestion: args.suggestion,
      aiApprove: args.approve ?? true,
    }
  } catch (err) {
    return errorResult(`AI 审批建议失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 任务板列表（agiteam_task_list）—— 查看项目任务板全部任务及状态。
 */
export async function executeTaskList(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; status?: string; cwd?: string },
): Promise<ToolResult> {
  const { openAgiteamDomain, getProject, listTasks } = await import('./store')
  try {
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)
    const tasks = listTasks(domain, args.projectId, args.status as never)
    return {
      status: 'ok',
      projectId: args.projectId,
      tasks: tasks.map(t => ({
        id: t.id,
        stage: t.stage,
        title: t.title,
        role: t.role,
        status: t.status,
        sessionId: t.sessionId,
        approvalSuggestion: t.approvalSuggestion,
        reviewComment: t.reviewComment,
        pausedByHuman: t.pausedByHuman,
        result: t.result.slice(0, 200),
        updatedAt: t.updatedAt,
      })),
    }
  } catch (err) {
    return errorResult(`任务列表失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 评审判定（agiteam_review）—— 评审角色判定 通过/打回。
 * 通过则自动前进，打回则带意见返回上一阶段。
 */
export async function executeReview(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; passed: boolean; comment?: string; cwd?: string },
): Promise<ToolResult> {
  const { openAgiteamDomain, getProject } = await import('./store')
  const { reviewDecision, autoDriveRuntimeFromCtx } = await import('./auto-drive')
  try {
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    // 角色会话 cwd 必须用项目 cwd（避免 sessionId 跨 cwd 持久化冲突）
    const rt = autoDriveRuntimeFromCtx(ctx, args.cwd ?? project?.cwd ?? process.cwd())
    const updated = await reviewDecision(ctx, domain, rt, args.projectId, args.passed, args.comment ?? '')
    const stageName = STAGE_NAMES[updated.stage as StageId] ?? updated.stage
    const verb = args.passed ? '通过' : '打回'
    return {
      status: 'ok',
      message: `评审${verb}，当前阶段：${stageName}。`,
      projectId: updated.id,
      stage: updated.stage,
      stageName,
      passed: args.passed,
    }
  } catch (err) {
    return errorResult(`评审判定失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 项目内新建需求（agiteam_new_requirement）—— 每次对话 = 一个需求。
 * 在已有项目内新建需求，自动进入该需求的需求分析（阶段会话）。
 */
export async function executeNewRequirement(
  ctx: Context,
  config: AgiteamConfig,
  args: { projectId: string; requirement: string; title?: string; cwd?: string },
): Promise<ToolResult> {
  try {
    const { openAgiteamDomain, getProject, upsertProject } = await import('./store')
    const { autoDriveRuntimeFromCtx } = await import('./auto-drive')
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`)

    // 需求编号：R-<递增>（基于项目内已有需求数）
    const reqCount = Object.keys(project.requirements ?? {}).length + 1
    const reqId = `R-${reqCount}`
    const title = args.title ?? `需求 ${reqId}`

    // 先唤醒需求分析师（需求×阶段专属会话），成功后才提交项目更新（防空转）
    const rt = autoDriveRuntimeFromCtx(ctx, project.cwd)
    const { stageGreeting } = await import('./auto-drive')
    const greeting = stageGreeting(project, 'requirement', `【新需求 ${reqId}】${title}\n${args.requirement}`)
    try {
      // taskboard 模式：ensureRole 随机 id + resume 续接（需求×阶段专属会话，不串内容）
      await rt.ensureRole(args.projectId, 'requirement', project.cwd, greeting, reqId, { provider: project.ownerProvider, model: project.ownerModel, effort: project.ownerEffort })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[dsh-agiteam] 新需求角色启动失败，需求未登记（project=${args.projectId}, reqId=${reqId}）:\n${detail}`)
      return errorResult(`新需求 ${reqId} 创建失败：需求分析师角色启动失败（${detail}）。请检查角色 preset/模型配置后重试。`)
    }

    // 更新项目：记录新需求到 requirements 表 + 设置 currentReqId（需求×阶段专属会话）
    const now = Date.now()
    const updated = {
      ...project,
      rawRequirement: args.requirement,
      stage: 'requirement' as const,
      currentReqId: reqId,
      requirements: { ...project.requirements, [reqId]: title },
      artifacts: { ...project.artifacts, [`requirement-${reqId}`]: `${reqId}` },
      updatedAt: now,
    }
    await upsertProject(domain, updated)

    return {
      status: 'ok',
      message: `项目「${project.name}」内新建需求 ${reqId}「${title}」，已进入需求分析（需求分析师已唤醒）。`,
      projectId: args.projectId,
      requirementId: reqId,
      title,
    }
  } catch (err) {
    return errorResult(`新建需求失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 主管分派执行者（agiteam_assign）—— 给 taskboard 任务指派执行智能体。
 *
 * 我是主管：任务批准（todo）后，由主管决定谁来执行——写入任务 source.executorPreset，
 * coordinator 扫描时启动对应 preset 的 agent。executor 取值：
 *  - 内置角色：requirement/product/developer/tester/architect（agiteam-* preset）
 *  - 通用工作：code（PTC 模式，含标准能力）
 *  - 其他已装 preset id
 * dependsOn（可选）：任务 id 数组。传入后自动给【每个前置任务】→【本任务】建
 * blocks 关系（前置 tasks blocks 目标任务），coordinator 会等到前置 done 才认领执行
 * ——实现"单测必须在代码写完后"这类顺序编排（与 taskboard UI 详情页 relations 等价）。
 */
export async function executeAssign(
  ctx: Context,
  config: AgiteamConfig,
  args: { taskId: string; executor: string; note?: string; dependsOn?: string[] },
): Promise<ToolResult> {
  try {
    const { loadTaskboard } = await import('./taskboard-bridge')
    const { DatabaseSync } = await import('node:sqlite')
    // 校验 executor 是已装 preset
    const PRESETS = ['code', 'requirement', 'product', 'developer', 'tester', 'architect',
      'req-reviewer', 'prod-reviewer', 'test-designer', 'supervisor']
    const presetId = PRESETS.includes(args.executor) ? `agiteam-${args.executor}`.replace('agiteam-code', 'code') : args.executor
    const db = new DatabaseSync('/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard.sqlite')
    const task = db.prepare('SELECT id, source_json, version, project_id FROM tasks WHERE id = ? OR identifier = ?').get(args.taskId, args.taskId) as
      { id: string; source_json: string | null; version: number; project_id: string } | undefined
    if (!task) { db.close(); return errorResult(`任务 ${args.taskId} 不存在（taskboard）`) }
    const source = task.source_json ? JSON.parse(task.source_json) as Record<string, unknown> : {}
    source.executorPreset = presetId
    source.executorAssignedAt = Date.now()
    db.prepare('UPDATE tasks SET source_json = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(source), Date.now(), task.id)
    // 写评论（记录分派）
    const commentId = `comment-${Date.now().toString(36)}`
    db.prepare(`INSERT INTO comments(id, task_id, body, author_id, session_id, version, created_at, updated_at)
      VALUES (?, ?, ?, 'human:supervisor', NULL, 1, ?, ?)`)
      .run(commentId, task.id, `主管分派：由 ${presetId} 执行${args.note ? `。说明：${args.note}` : ''}`, Date.now(), Date.now())
    // dependsOn：解析每个前置任务 id（支持 identifier），给前置→本任务建 blocks 链。
    // 注意：先关掉本工具自开的 DatabaseSync 连接，再走 provider.addRelation
    // （tbAddDependency 内部开 taskboard provider 连接）——避免 SQLite 双写连接 busy。
    // provider 路径同时写 activity 审计 + bump version/revision，UI change-watch 可实时刷新。
    const dependencyTargets: Array<{ id: string; version: number }> = []
    for (const dependency of args.dependsOn ?? []) {
      const dep = db.prepare('SELECT id, identifier, status, version FROM tasks WHERE id = ? OR identifier = ?').get(dependency, dependency) as
        | { id: string; identifier: string; status: string; version: number } | undefined
      if (!dep) { db.close(); return errorResult(`dependsOn 任务 ${dependency} 不存在（先创建它）`) }
      if (dep.id === task.id) { db.close(); return errorResult(`dependsOn 不能依赖自身（${args.taskId}）`) }
      dependencyTargets.push({ id: dep.id, version: dep.version })
    }
    db.close()
    if (dependencyTargets.length > 0) {
      const { tbAddDependency } = await import('./agiteam-tb')
      for (const dep of dependencyTargets) tbAddDependency(dep.id, dep.version, task.id)
    }
    return {
      status: 'ok',
      message: `已分派执行者 ${presetId} 执行任务 ${args.taskId}（coordinator 将自动启动该 agent）${dependencyTargets.length > 0 ? `。已建 ${dependencyTargets.length} 条前置依赖（blocks），前置完成前不会执行` : ''}。`,
      taskId: args.taskId,
      executor: presetId,
      ...(dependencyTargets.length > 0 ? { dependsOn: dependencyTargets.map(item => item.id) } : {}),
    }
  } catch (err) {
    return errorResult(`分派失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

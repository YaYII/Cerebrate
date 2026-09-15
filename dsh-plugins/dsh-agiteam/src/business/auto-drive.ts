/**
 * 自动驱动引擎 —— 阶段完成自动推进 + 唤醒下一角色。
 *
 * 解决"为什么不是自动驱动"：以前每个阶段要手动 agiteam_advance。
 * 现在角色完成当前阶段任务后调用 agiteam_done，本引擎自动：
 *  1. 把当前任务标记 done；
 *  2. 推进阶段（评审阶段由 agiteam_review 判定 pass/打回）；
 *  3. 创建下一阶段任务并唤醒对应角色 agent；
 *  4. 记录审计。
 *
 * 直到 done 阶段（交付）为止全自动接力。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StageId } from '../features/stage'
import { nextStage, reviewBackTo, STAGE_NAMES, isReviewStage } from '../features/stage'
import { STAGE_ROLE, ROLE_NAMES, type TeamRole } from './roles'
import type { AgiteamDomain, } from './store'
import { getProject, upsertProject, upsertTask, appendAuditRecord, listTasks, openTasks, lastAudit } from './store'
import type { ProjectRecordType as ProjectRecord, TaskRecordType as TaskRecord } from './domain'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { makeAuditEntry } from '../features/audit'
import { syncArtifactToKb, syncReviewToKb, syncApprovalsToKb, approvalEntryLine, safeSegment, type ApprovalRecordEntry } from '../features/kb-sync'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ensureRoleSession, sessionServicesFromCtx, type RoleSessionIdentity } from './sessions'

/** 自动驱动依赖的运行时能力（agent 唤醒）。 */
export interface AutoDriveRuntime {
  /** 唤醒角色 agent（投递引导消息）。返回是否成功。reqId 为需求 id（需求×阶段专属会话）。 */
  wakeRole(projectId: string, role: TeamRole, text: string, reqId?: string): Promise<boolean>
  /** 创建角色 agent（会话不存在时）。reqId 为需求 id。modelOpts 为继承的模型（provider/model/effort）。 */
  createRole(projectId: string, role: TeamRole, cwd: string, greeting: string, reqId?: string, modelOpts?: { provider?: string; model?: string; effort?: string }): Promise<void>
  /** 以 taskboard 模式确保角色会话就绪并投递引导消息（随机 id + resume 续接）。 */
  ensureRole(projectId: string, role: TeamRole, cwd: string, greeting: string, reqId?: string, modelOpts?: { provider?: string; model?: string; effort?: string }, existingSessionId?: string): Promise<{ sessionId: string; created: boolean }>
  /** 判断绝对路径是否存在（用于评审前的产物闸门校验）。 */
  exists(absPath: string): Promise<boolean>
  /** 项目工作目录。 */
  cwd: string
}

/** 从 Cordis Context 构造自动驱动运行时（复用 engine 的 agent 服务）。 */
export function autoDriveRuntimeFromCtx(ctx: Context, cwd: string): AutoDriveRuntime {
  const agents = ctx.get('agents') as {
    get(id: SessionId): { followup(msg: unknown): void } | undefined
    create(opts: {
      sessionId: SessionId
      meta?: { cwd?: string; agentPreset?: string }
      setup?(ctx: unknown): Promise<void>
    }): Promise<{ agent: { followup(msg: unknown): void } }>
  } | undefined
  const agentPresets = ctx.get('agentPresets') as {
    resolve(id: string): Promise<unknown>
    mount(ctx: unknown, id: string): Promise<unknown>
  } | undefined
  const workspaceRegistry = ctx.get('workspaceRegistry') as {
    resolveByPath(path: string): Promise<{ attachSession(sid: string): Promise<void> } | undefined>
  } | undefined
  // dsh-fs：resolve(path) → target，再 stat(target) 判断存在性
  const fs = ctx.get('fs') as {
    resolve(path: string): Promise<{ targetKey: string; displayPath: string }>
    stat(target: { targetKey: string; displayPath: string }): Promise<unknown>
  } | undefined

  // 会话服务（taskboard 模式：随机唯一 id + resume 续接）
  const sessions = sessionServicesFromCtx(ctx)

  return {
    cwd,
    async exists(absPath) {
      if (!fs) return false
      try {
        const target = await fs.resolve(absPath)
        return (await fs.stat(target)) !== undefined
      } catch {
        return false
      }
    },
    async wakeRole(projectId, role, text, reqId) {
      // 兼容旧调用：活会话命中才投递（无活会话返回 false，调用方走 ensureRole 创建/续接）
      const legacyId = (reqId ? `session-${projectId}-${reqId}-${role}` : `session-${projectId}-${role}`) as SessionId
      const live = agents?.get(legacyId)
      if (live && typeof live.followup === 'function') {
        live.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'dsh-agiteam', form: 'instructions' },
        }))
        return true
      }
      return false
    },
    async createRole(projectId, role, roleCwd, greeting, reqId, modelOpts) {
      // 兼容旧调用：转为 ensureRole（随机 id + resume 续接）
      const identity: RoleSessionIdentity = { projectId, role }
      if (reqId) identity.reqId = reqId
      await ensureRoleSession(ctx, sessions, identity, roleCwd, greeting, modelOpts)
    },
    async ensureRole(projectId, role, roleCwd, greeting, reqId, modelOpts, existingSessionId) {
      const identity: RoleSessionIdentity = { projectId, role }
      if (reqId) identity.reqId = reqId
      const result = await ensureRoleSession(ctx, sessions, identity, roleCwd, greeting, modelOpts, existingSessionId)
      return { sessionId: result.sessionId, created: result.created }
    },
  }
}

/** 阶段引导消息。 */
export function stageGreeting(project: ProjectRecord, stage: string, extra?: string): string {
  const name = STAGE_NAMES[stage as StageId] ?? stage
  const role = STAGE_ROLE[stage] as TeamRole | undefined
  const roleName = role ? ROLE_NAMES[role] : '对应角色'
  const lines = [
    `【dsh-agiteam】项目「${project.name}」进入阶段：${name}。`,
    `你作为${roleName}，请完成本阶段工作。`,
  ]
  if (extra) lines.push('', extra)
  lines.push('', '完成后调用 agiteam_done 提交结果（评审阶段调用 agiteam_review 判定）。')
  return lines.join('\n')
}

/** 创建阶段任务（若该阶段尚无 open 任务）。 */
export async function ensureStageTask(domain: AgiteamDomain, project: ProjectRecord, stage: string): Promise<TaskRecord | undefined> {
  const existing = openTasks(domain, project.id)
  if (existing.length > 0) return existing[0]
  const role = STAGE_ROLE[stage] as TeamRole | undefined
  if (!role) return undefined
  const task: TaskRecord = {
    id: `T-${Date.now().toString(36)}`,
    projectId: project.id,
    stage,
    title: `${STAGE_NAMES[stage as StageId] ?? stage}（${ROLE_NAMES[role]}）`,
    role,
    status: 'open',
    sessionId: '',
    result: '',
    approvalSuggestion: '',
    approvalSource: 'human',
    reviewComment: '',
    pausedByHuman: false,
    pauseReason: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await upsertTask(domain, task)
  return task
}

/**
 * 唤醒阶段角色（taskboard 完整闭环：随机 id + resume 续接 + 写回任务记录）。
 *
 * 顺序：
 *  1. 读任务记录 sessionId（若有）→ 活会话命中直接 followup；
 *  2. 无活会话 → agents.resume() 续接同一持久化会话（不 create，避开崩溃）；
 *  3. 无记录/续接失败 → 创建全新随机 id 会话，写回任务记录。
 *
 * @returns 生效的 sessionId + 是否新建。
 */
export async function wakeStageRole(
  domain: AgiteamDomain,
  rt: AutoDriveRuntime,
  project: ProjectRecord,
  role: TeamRole,
  greeting: string,
): Promise<{ sessionId: string; created: boolean }> {
  // 找当前阶段任务（取最新一个）
  const tasks = listTasks(domain, project.id)
    .filter(t => t.stage === project.stage && t.status !== 'done')
    .sort((a, b) => b.createdAt - a.createdAt)
  const task = tasks[0]
  const existingSessionId = task?.sessionId || undefined
  const result = await rt.ensureRole(
    project.id,
    role,
    project.cwd,
    greeting,
    project.currentReqId || undefined,
    { provider: project.ownerProvider, model: project.ownerModel, effort: project.ownerEffort },
    existingSessionId,
  )
  // 新建会话时写回任务记录（taskboard：重启后可 resume 续接同一对话）
  if (task && result.created) {
    await upsertTask(domain, { ...task, sessionId: result.sessionId, status: task.status === 'open' ? 'claimed' : task.status, updatedAt: Date.now() })
  }
  return result
}

/**
 * 阶段完成自动推进（agiteam_done 核心）。
 *
 * 任务板审批模式：
 *  1. 角色完成阶段 → 当前阶段任务提交 in_review（含完成结果 + 审批建议）；
 *  2. 通知主会话（你）审批：agiteam_approve 放行 → 推进到下一阶段；
 *     或 agiteam_reject 打回（带意见返回返工）；或 agiteam_pause 暂停。
 *  3. AI 可代为审批（agiteam_ai_approve 提交建议），但最终放行权在你。
 *
 * @param ctx 插件上下文
 * @param domain 存储域
 * @param rt 自动驱动运行时
 * @param projectId 项目 id
 * @param result 完成结果描述
 * @param suggestion 审批建议（AI 代审批时附带）
 * @returns 推进后的项目记录
 */
export async function autoAdvance(
  ctx: Context,
  domain: AgiteamDomain,
  rt: AutoDriveRuntime,
  projectId: string,
  result: string,
  suggestion = '',
): Promise<ProjectRecord> {
  const project = getProject(domain, projectId)
  if (!project) throw new Error(`项目 ${projectId} 不存在`)

  // 1. 当前阶段任务提交 in_review（等人工审批，不直接 done）
  const currentTasks = listTasks(domain, projectId)
  for (const task of currentTasks.filter(t => t.status === 'open' || t.status === 'claimed' || t.status === 'in_progress')) {
    await upsertTask(domain, {
      ...task,
      status: 'in_review',
      result,
      approvalSuggestion: suggestion,
      updatedAt: Date.now(),
    })
  }

  // 2. 记录审计（阶段完成，链式哈希）
  const auditSeq = nextAuditSeq(domain, projectId)
  const prevHash = lastAuditHash(domain, projectId)
  const entry = makeAuditEntry(auditSeq, {
    time: Date.now(),
    action: 'stage-done',
    role: STAGE_ROLE[project.stage] ?? 'system',
    projectId,
    stage: project.stage,
    detail: JSON.stringify({ stage: project.stage, result, suggestion }),
  }, prevHash)
  await appendAuditRecord(domain, entry)

  // 3. 评审阶段由 agiteam_review 判定；普通阶段等待人工审批后由 agiteam_approve 推进
  const current = project.stage as StageId
  if (isReviewStage(current)) {
    // 评审阶段不能 autoAdvance（必须由评审角色显式判定）
    return project
  }

  // 4. 通知主会话（你）审批放行
  const stageName = STAGE_NAMES[current] ?? current
  notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${stageName}」已完成，任务已提交审批（in_review）。请审批：agiteam_approve 放行推进，或 agiteam_reject 打回，或 agiteam_pause 暂停。`)
  return project
}

/**
 * 人工审批放行阶段（agiteam_approve）：in_review → done，推进到下一阶段。
 * 只有 human（你）可调用。审批后可选择是否立即推进（默认推进）。
 */
export async function approveStage(
  ctx: Context,
  domain: AgiteamDomain,
  rt: AutoDriveRuntime,
  projectId: string,
  comment = '',
  advanceNext = true,
): Promise<ProjectRecord> {
  const project = getProject(domain, projectId)
  if (!project) throw new Error(`项目 ${projectId} 不存在`)

  // 1. 当前阶段 in_review 任务 → done（人工批准）
  const currentTasks = listTasks(domain, projectId)
  for (const task of currentTasks.filter(t => t.status === 'in_review')) {
    await upsertTask(domain, {
      ...task,
      status: 'done',
      approvalSource: 'human',
      reviewComment: comment,
      approvedAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  // 2. 记录审计（审批放行）
  const auditSeq = nextAuditSeq(domain, projectId)
  const prevHash = lastAuditHash(domain, projectId)
  const current = project.stage as StageId
  await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
    time: Date.now(),
    action: 'stage-approved',
    role: 'human',
    projectId,
    stage: current,
    detail: JSON.stringify({ stage: current, comment, approvalSource: 'human' }),
  }, prevHash))

  // 3. 评审阶段：由 agiteam_review 判定打回/通过（此处只处理普通阶段）
  if (isReviewStage(current)) {
    return project
  }

  // 4. 推进阶段（审批通过后自动推进到下一阶段，唤醒下一角色）
  const next = nextStage(current)
  if (!next) {
    // done：项目交付
    project.stage = 'done'
    project.completed[current] = true
    project.updatedAt = Date.now()
    await upsertProject(domain, project)
    return project
  }
  if (!advanceNext) {
    // 不立即推进：任务已放行，阶段保持（等待你手动 agiteam_advance）
    project.updatedAt = Date.now()
    await upsertProject(domain, project)
    return project
  }

  // 先创建下一阶段任务（taskboard：新阶段 = 新任务，会话记录在任务上）
  const role = STAGE_ROLE[next] as TeamRole | undefined
  if (role) {
    // 推进前先把项目 stage 设为 next，让 wakeStageRole 能找到新阶段任务
    const nextProject = { ...project, stage: next }
    const nextTask = await ensureStageTask(domain, nextProject, next)
    const greeting = stageGreeting(project, next)
    try {
      await wakeStageRole(domain, rt, nextProject, role, greeting)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[dsh-agiteam] 审批通过但角色启动失败，阶段流转中断（project=${projectId}, stage=${next}, role=${role}）:\n${detail}`)
      throw new Error(`审批通过但角色启动失败（${role}），阶段流转已中断：${detail}。请检查角色 preset/模型配置后重试 agiteam_approve。`)
    }
    void nextTask
  }

  // 5. 角色就绪后提交阶段推进
  project.stage = next
  project.completed[current] = true
  project.updatedAt = Date.now()
  await upsertProject(domain, project)

  // 6. 同步产物到 Obsidian 团队知识库（best-effort）+ 同步审批记录 + 通知主会话继续指挥
  try {
    await syncProjectToKb(project, current)
  } catch { /* 知识库同步失败不阻断流程 */ }
  try {
    await syncApprovalToKb(project, {
      time: Date.now(),
      taskId: currentTasks.find(t => t.stage === current)?.id ?? '',
      title: STAGE_NAMES[current] ?? current,
      stage: current,
      action: 'stage-approved',
      source: 'human',
      comment,
    })
  } catch { /* 审批记录同步失败不阻断 */ }
  const nextName = STAGE_NAMES[next] ?? next
  notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」已审批放行，自动推进到「${nextName}」。${project.kbPath ? '产物已同步到团队知识库。' : ''}请继续指挥。`)
  return project
}

/** 评审判定（agiteam_review 核心）：通过前进，打回返回上一阶段。 */
export async function reviewDecision(
  ctx: Context,
  domain: AgiteamDomain,
  rt: AutoDriveRuntime,
  projectId: string,
  passed: boolean,
  comment: string,
): Promise<ProjectRecord> {
  const project = getProject(domain, projectId)
  if (!project) throw new Error(`项目 ${projectId} 不存在`)
  const current = project.stage as StageId
  if (!isReviewStage(current)) throw new Error(`当前阶段 ${current} 不是评审阶段`)

  // 防 AI 幻觉闸门：评审通过前必须验证上一阶段产物存在（无产物 = 拒绝通过）
  // 需求评审 → requirements.md；产品评审 → features.md；用例评审 → testcases.md
  const artifactCheck: Partial<Record<StageId, string>> = {
    'req-review': `${project.cwd.replace(/\/+$/, '')}/requirements/requirements.md`,
    'product-review': `${project.cwd.replace(/\/+$/, '')}/features/features.md`,
    'testcase-review': `${project.cwd.replace(/\/+$/, '')}/testcases/testcases.md`,
  }
  const expectedArtifact = artifactCheck[current]
  if (passed && expectedArtifact) {
    const artifactExists = await rt.exists(expectedArtifact)
    if (!artifactExists) {
      const detail = `评审通过被拒绝：上一阶段产物不存在（${expectedArtifact}）。请先让对应角色产出产物再评审，避免「无产物通过评审」的空转。`
      console.error(`[dsh-agiteam] ${detail}（project=${projectId}, stage=${current}）`)
      throw new Error(detail)
    }
  }

  // 记录评审意见
  const comments = project.reviewComments[current] ?? []
  comments.push(comment)
  project.reviewComments[current] = comments

  // 记录审计（链式哈希）
  const auditSeq = nextAuditSeq(domain, projectId)
  const prevHash = lastAuditHash(domain, projectId)
  const entry = makeAuditEntry(auditSeq, {
    time: Date.now(),
    action: passed ? 'review-pass' : 'review-reject',
    role: STAGE_ROLE[current] ?? 'reviewer',
    projectId,
    stage: current,
    detail: JSON.stringify({ stage: current, passed, comment }),
  }, prevHash)
  await appendAuditRecord(domain, entry)

  if (passed) {
    // 通过：前进到下一阶段（先唤醒下一角色，成功后才推进——防空转）
    const next = nextStage(current)
    if (next) {
      const role = STAGE_ROLE[next] as TeamRole | undefined
      if (role) {
        const nextProject = { ...project, stage: next }
        const nextTask = await ensureStageTask(domain, nextProject, next)
        const greeting = stageGreeting(project, next)
        try {
          await wakeStageRole(domain, rt, nextProject, role, greeting)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          console.error(`[dsh-agiteam] 评审通过但角色启动失败，阶段流转中断（project=${projectId}, stage=${next}, role=${role}）:\n${detail}`)
          throw new Error(`评审通过但角色启动失败（${role}），阶段流转已中断：${detail}。请检查角色 preset/模型配置后重试 agiteam_review。`)
        }
        void nextTask
      }
      project.stage = next
      project.completed[current] = true
      project.updatedAt = Date.now()
      await upsertProject(domain, project)
    }
  } else {
    // 打回：返回上一阶段（带意见）
    const back = reviewBackTo(current)
    if (back) {
      project.stage = back
      project.updatedAt = Date.now()
      await upsertProject(domain, project)
      const role = STAGE_ROLE[back] as TeamRole | undefined
      if (role) {
        const backProject = { ...project, stage: back }
        const backTask = await ensureStageTask(domain, backProject, back)
        const greeting = stageGreeting(project, back, `【评审打回】意见：${comment}`)
        try {
          await wakeStageRole(domain, rt, backProject, role, greeting)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          console.error(`[dsh-agiteam] 评审打回后角色启动失败（project=${projectId}, stage=${back}, role=${role}）:\n${detail}`)
        }
        void backTask
      }
    }
  }
  // 评审后：同步评审记录/产物到知识库 + 通知主会话
  try {
    await syncProjectToKb(project, current, project.reviewComments[current] ?? [])
  } catch { /* 知识库同步失败不阻断流程 */ }
  const verb = passed ? '通过' : '打回'
  const stageName = STAGE_NAMES[project.stage as StageId] ?? project.stage
  notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current as StageId] ?? current}」评审${verb}，当前阶段：${stageName}。${project.kbPath ? '评审记录已同步到团队知识库。' : ''}请继续指挥。`)
  return project
}

/** 计算下一个审计 seq。 */
function nextAuditSeq(domain: AgiteamDomain, projectId: string): number {
  const last = lastAudit(domain, projectId)
  return last ? last.seq + 1 : 1
}

/**
 * 把当前审批动作同步到 Obsidian 任务板审批记录（best-effort，失败不阻断）。
 * @param project 项目记录（kbPath）
 * @param entry 审批记录条目
 */
async function syncApprovalToKb(project: ProjectRecord, entry: ApprovalRecordEntry): Promise<void> {
  if (!project.kbPath) return
  try {
    // 追加到已有审批记录（读旧文件 + 追加新条目，保历史）
    const { readFile, writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { KB_VAULT_ROOT } = await import('../features/kb-sync')
    const absDir = join(KB_VAULT_ROOT, project.kbPath)
    const target = join(absDir, '任务板审批记录.md')
    await mkdir(absDir, { recursive: true })
    let prev = ''
    try { prev = await readFile(target, 'utf8') } catch { /* 首次写入 */ }
    const line = approvalEntryLine(entry)
    if (prev.includes(line)) return // 幂等：同条目不重复
    await writeFile(target, `${prev.trimEnd()}\n${line}\n`, 'utf8')
  } catch { /* 同步失败不阻断 */ }
}

/**
 * 人工打回阶段（agiteam_reject）：in_review → rejected，带意见返回返工。
 * 只有 human（你）可调用。
 */
export async function rejectStage(
  ctx: Context,
  domain: AgiteamDomain,
  rt: AutoDriveRuntime,
  projectId: string,
  comment: string,
): Promise<ProjectRecord> {
  const project = getProject(domain, projectId)
  if (!project) throw new Error(`项目 ${projectId} 不存在`)
  const current = project.stage as StageId

  // 当前阶段 in_review 任务 → rejected（带意见）
  const currentTasks = listTasks(domain, projectId)
  for (const task of currentTasks.filter(t => t.status === 'in_review')) {
    await upsertTask(domain, {
      ...task,
      status: 'rejected',
      reviewComment: comment,
      approvalSource: 'human',
      updatedAt: Date.now(),
    })
  }

  // 记录审计（打回）
  const auditSeq = nextAuditSeq(domain, projectId)
  const prevHash = lastAuditHash(domain, projectId)
  await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
    time: Date.now(),
    action: 'stage-rejected',
    role: 'human',
    projectId,
    stage: current,
    detail: JSON.stringify({ stage: current, comment }),
  }, prevHash))

  // 打回：返回上一阶段（带意见）或停留在当前阶段重做
  const back = reviewBackTo(current) ?? current
  project.stage = back
  project.updatedAt = Date.now()
  await upsertProject(domain, project)
  const role = STAGE_ROLE[back] as TeamRole | undefined
  if (role) {
    const backProject = { ...project, stage: back }
    const backTask = await ensureStageTask(domain, backProject, back)
    const greeting = stageGreeting(project, back, `【打回返工】意见：${comment}`)
    try {
      await wakeStageRole(domain, rt, backProject, role, greeting)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[dsh-agiteam] 打回后角色启动失败（project=${projectId}, stage=${back}, role=${role}）:\n${detail}`)
    }
    void backTask
  }
  const backName = STAGE_NAMES[back] ?? back
  try {
    await syncApprovalToKb(project, {
      time: Date.now(),
      taskId: currentTasks.find(t => t.stage === current)?.id ?? '',
      title: STAGE_NAMES[current] ?? current,
      stage: current,
      action: 'stage-rejected',
      source: 'human',
      comment,
    })
  } catch { /* 审批记录同步失败不阻断 */ }
  notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」被打回（${comment}），返回阶段「${backName}」返工。`)
  return project
}

/**
 * 人工暂停阶段（agiteam_pause）：随时暂停当前阶段（你是魔王）。
 * paused 任务不会自动推进；恢复用 agiteam_resume。
 */
export async function pauseStage(
  ctx: Context,
  domain: AgiteamDomain,
  projectId: string,
  reason: string,
): Promise<ProjectRecord> {
  const project = getProject(domain, projectId)
  if (!project) throw new Error(`项目 ${projectId} 不存在`)
  const current = project.stage as StageId
  const currentTasks = listTasks(domain, projectId)
  for (const task of currentTasks.filter(t => t.status !== 'done' && t.status !== 'failed')) {
    await upsertTask(domain, {
      ...task,
      status: 'paused',
      pausedByHuman: true,
      pauseReason: reason,
      updatedAt: Date.now(),
    })
  }
  // 记录审计（暂停）
  const auditSeq = nextAuditSeq(domain, projectId)
  const prevHash = lastAuditHash(domain, projectId)
  await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
    time: Date.now(),
    action: 'stage-paused',
    role: 'human',
    projectId,
    stage: current,
    detail: JSON.stringify({ stage: current, reason }),
  }, prevHash))
  try {
    await syncApprovalToKb(project, {
      time: Date.now(),
      taskId: currentTasks.find(t => t.stage === current)?.id ?? '',
      title: STAGE_NAMES[current] ?? current,
      stage: current,
      action: 'stage-paused',
      source: 'human',
      comment: reason,
    })
  } catch { /* 审批记录同步失败不阻断 */ }
  notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」已暂停（${reason}）。恢复用 agiteam_resume。`)
  return project
}

/**
 * 恢复暂停阶段（agiteam_resume）：paused → in_progress，继续当前阶段。
 */
export async function resumeStage(
  ctx: Context,
  domain: AgiteamDomain,
  rt: AutoDriveRuntime,
  projectId: string,
): Promise<ProjectRecord> {
  const project = getProject(domain, projectId)
  if (!project) throw new Error(`项目 ${projectId} 不存在`)
  const current = project.stage as StageId
  const currentTasks = listTasks(domain, projectId)
  for (const task of currentTasks.filter(t => t.status === 'paused')) {
    await upsertTask(domain, {
      ...task,
      status: 'in_progress',
      pausedByHuman: false,
      pauseReason: '',
      updatedAt: Date.now(),
    })
  }
  const auditSeq = nextAuditSeq(domain, projectId)
  const prevHash = lastAuditHash(domain, projectId)
  await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
    time: Date.now(),
    action: 'stage-resumed',
    role: 'human',
    projectId,
    stage: current,
    detail: JSON.stringify({ stage: current }),
  }, prevHash))
  // 唤醒当前阶段角色继续（taskboard：续接同一会话）
  const role = STAGE_ROLE[current] as TeamRole | undefined
  if (role) {
    const greeting = stageGreeting(project, current, '【恢复】任务已恢复，请继续完成本阶段工作。')
    try {
      await wakeStageRole(domain, rt, project, role, greeting)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[dsh-agiteam] 恢复后角色启动失败（project=${projectId}, stage=${current}, role=${role}）:\n${detail}`)
    }
  }
  try {
    await syncApprovalToKb(project, {
      time: Date.now(),
      taskId: currentTasks.find(t => t.stage === current)?.id ?? '',
      title: STAGE_NAMES[current] ?? current,
      stage: current,
      action: 'stage-resumed',
      source: 'human',
      comment: '恢复执行',
    })
  } catch { /* 审批记录同步失败不阻断 */ }
  notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」已恢复，角色已唤醒继续。`)
  return project
}

/**
 * AI 代为审批（agiteam_ai_approve）：AI 依据验收标准给出审批建议，
 * 提交到任务（in_review 或直接建议），但最终放行权在 human（你）。
 * 返回建议详情，供你决定采纳/驳回。
 */
export async function aiApproveSuggestion(
  ctx: Context,
  domain: AgiteamDomain,
  projectId: string,
  suggestion: string,
  approve: boolean,
): Promise<ProjectRecord> {
  const project = getProject(domain, projectId)
  if (!project) throw new Error(`项目 ${projectId} 不存在`)
  const current = project.stage as StageId
  const currentTasks = listTasks(domain, projectId)
  for (const task of currentTasks.filter(t => t.status === 'in_review')) {
    await upsertTask(domain, {
      ...task,
      approvalSuggestion: suggestion,
      approvalSource: 'ai',
      reviewComment: approve ? 'AI 建议放行（等待人工确认）' : `AI 建议打回：${suggestion}`,
      updatedAt: Date.now(),
    })
  }
  const auditSeq = nextAuditSeq(domain, projectId)
  const prevHash = lastAuditHash(domain, projectId)
  await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
    time: Date.now(),
    action: 'ai-approval-suggestion',
    role: 'ai',
    projectId,
    stage: current,
    detail: JSON.stringify({ stage: current, suggestion, approve }),
  }, prevHash))
  notifyOwnerSession(ctx, project, `【dsh-agiteam】AI 对项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」给出审批建议：${approve ? '建议放行' : '建议打回'}。${suggestion}。最终决定权在你：agiteam_approve / agiteam_reject。`)
  return project
}

/** 计算审计链 prevHash（末条 hash，无则 GENESIS）。 */
function lastAuditHash(domain: AgiteamDomain, projectId: string): string {
  const last = lastAudit(domain, projectId)
  return last ? last.hash : 'GENESIS'
}

/**
 * 阶段流转后把产物同步到 Obsidian 团队知识库（best-effort，失败不阻断流程）。
 * @param project 项目记录（cwd/kbPath）
 * @param stage 当前阶段（决定同步哪些产物）
 * @param reviewEntries 评审记录（评审阶段传入）
 */
export async function syncProjectToKb(
  project: ProjectRecord,
  stage: string,
  reviewEntries?: string[],
): Promise<Array<{ file: string; ok: boolean }>> {
  const results: Array<{ file: string; ok: boolean }> = []
  if (!project.kbPath || !project.cwd) return results
  try {
    // 评审阶段：同步评审记录 + 被评审产物
    if (isReviewStage(stage as StageId)) {
      const kbDir = project.kbPath
      if (reviewEntries && reviewEntries.length > 0) {
        try {
          const file = await syncReviewToKb(kbDir, STAGE_NAMES[stage as StageId] ?? stage, reviewEntries)
          results.push({ file, ok: true })
        } catch (err) {
          results.push({ file: '评审记录.md', ok: false })
          console.error(`[dsh-agiteam] 评审记录同步失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // 评审对应产物（req-review→requirements，product-review→features，testcase-review→testcases）
      const artifactMap: Partial<Record<StageId, string>> = {
        'req-review': 'requirements',
        'product-review': 'features',
        'testcase-review': 'testcases',
      }
      const artifact = artifactMap[stage as StageId]
      if (artifact) {
        try {
          const file = await syncArtifactToKb(project.cwd, kbDir, artifact)
          if (file) results.push({ file, ok: true })
        } catch (err) {
          results.push({ file: KB_FILE_NAME(artifact), ok: false })
          console.error(`[dsh-agiteam] 产物 ${artifact} 同步失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return results
    }
    // 普通阶段：同步对应产物
    const artifactMap: Partial<Record<StageId, string>> = {
      requirement: 'requirements',
      product: 'features',
      testcase: 'testcases',
      'feature-accept': 'acceptance',
      'e2e-accept': 'acceptance',
    }
    const artifact = artifactMap[stage as StageId]
    if (artifact) {
      try {
        const file = await syncArtifactToKb(project.cwd, project.kbPath, artifact)
        if (file) results.push({ file, ok: true })
      } catch (err) {
        results.push({ file: KB_FILE_NAME(artifact), ok: false })
        console.error(`[dsh-agiteam] 产物 ${artifact} 同步失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return results
  } catch (err) {
    console.error(`[dsh-agiteam] 知识库同步异常: ${err instanceof Error ? err.message : String(err)}`)
    return results
  }
}

/** 产物类型 → 知识库文件名（供失败时展示）。 */
function KB_FILE_NAME(artifact: string): string {
  const map: Record<string, string> = {
    requirements: '需求清单.md',
    features: '产品方案.md',
    testcases: '测试用例.md',
    acceptance: '验收报告.md',
  }
  return map[artifact] ?? `${artifact}.md`
}

/**
 * 通知项目发起会话（主智能体）：阶段流转完成，请继续指挥。
 * 主会话 id 在 agiteam_start 时记录到 project.ownerSession。
 * @param ctx 插件上下文（agents 服务）
 * @param project 项目记录
 * @param message 通知内容
 */
export function notifyOwnerSession(ctx: Context, project: ProjectRecord, message: string): void {
  if (!project.ownerSession) return
  const agents = ctx.get('agents') as {
    get(id: SessionId): { followup(msg: unknown): void } | undefined
  } | undefined
  const owner = agents?.get(project.ownerSession as SessionId)
  if (!owner || typeof owner.followup !== 'function') {
    console.error(`[dsh-agiteam] 主会话 ${project.ownerSession} 不可用（未唤醒或已结束），无法通知`)
    return
  }
  owner.followup(createUserMessage({
    content: [{ type: 'text', text: message }],
    source: { kind: 'plugin', plugin: 'dsh-agiteam', form: 'instructions' },
  }))
}

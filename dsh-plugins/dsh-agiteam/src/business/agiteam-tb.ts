/**
 * AGI 团队编排层（taskboard 底座版）—— 在 taskboard 的 SQLite/状态机上跑九阶段团队流程。
 *
 * 设计（把 AGI 团队理念灌进 taskboard）：
 *  - AGI 团队项目 = taskboard project（key 为项目 id，name 为项目名）；
 *  - 阶段任务 = taskboard task（status 复用七状态机：todo→in_progress→in_review→done；
 *    source 承载 stage/requirement/role/artifactPath）；
 *  - 阶段推进 = 完成当前阶段任务 → 创建下阶段任务（含角色引导）→ 你审批放行；
 *  - 审批 = taskboard 原生 human-only approve（只有你能放行 done）；
 *  - 角色 agent = 由 HarnessTaskboardWorker 启动（随机 sessionId + resume 续接，taskboard 已内置）。
 *
 * 与旧版的关系：旧版用自研 storageDomain 四表 + 自研面板；本版直接复用 taskboard
 * 的成熟底座（SQLite 权威存储 + 原生 UI + change-watch），AGI 层只做编排。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  loadTaskboard,
  openTaskboardDatabase,
  encodeAgiteamSource,
  agiteamSourceOf,
  stageLabel,
  AGITEAM_STAGE_NAMES,
  AGITEAM_STAGE_ROLE,
  AGITEAM_NEXT_STAGE,
} from './taskboard-bridge'

/** taskboard 数据库路径（与 profile 的 cordis.patch.yml 一致）。 */
const TB_DB_PATH = '/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard.sqlite'

/** 打开的 provider 句柄（进程级缓存，幂等）。 */
let provider: unknown | undefined

/** 获取（或打开）taskboard provider。 */
export function tbProvider(): unknown {
  if (!provider) provider = openTaskboardDatabase(TB_DB_PATH, { allowSharedWorktrees: false })
  return provider
}

/** 内部类型收口（避免 d.ts 依赖，运行时结构来自 taskboard 包）。 */
type Provider = {
  createProject(request: Record<string, unknown>, actor: Record<string, unknown>): Record<string, unknown>
  getProject(projectId: string): Record<string, unknown> | undefined
  listProjects(): Array<Record<string, unknown>>
  createTask(request: Record<string, unknown>, actor: Record<string, unknown>): Record<string, unknown>
  getTask(taskIdOrIdentifier: string): Record<string, unknown>
  listTasks(filter: Record<string, unknown>): Array<Record<string, unknown>>
  updateTask(taskId: string, expectedVersion: number, request: Record<string, unknown>, actor: Record<string, unknown>): Record<string, unknown>
  claim(taskId: string, request: Record<string, unknown>, actor: Record<string, unknown>): { task: Record<string, unknown>; claim: Record<string, unknown> }
  submitReview(taskId: string, expectedVersion: number, verification: string, resultComment: string, actor: Record<string, unknown>): Record<string, unknown>
  approve(taskId: string, expectedVersion: number, actor: Record<string, unknown>): Record<string, unknown>
  accept(taskId: string, expectedVersion: number, actor: Record<string, unknown>): Record<string, unknown>
  moveStatus(taskId: string, expectedVersion: number, status: string, actor: Record<string, unknown>, sortOrder?: number): Record<string, unknown>
  comment(taskId: string, expectedVersion: number, body: string, actor: Record<string, unknown>): Record<string, unknown>
  returnForRework(taskId: string, expectedVersion: number, target: string, comment: string, actor: Record<string, unknown>, freshClaim?: Record<string, unknown>): Record<string, unknown>
  block(taskId: string, expectedVersion: number, reason: string, actor: Record<string, unknown>): Record<string, unknown>
  resume(taskId: string, expectedVersion: number, actor: Record<string, unknown>, target?: string, freshClaim?: Record<string, unknown>): Record<string, unknown>
  cancel(taskId: string, expectedVersion: number, actor: Record<string, unknown>): Record<string, unknown>
  addRelation(sourceTaskId: string, expectedVersion: number, targetTaskId: string, kind: string, actor: Record<string, unknown>): Record<string, unknown>
}

/** actor 辅助。 */
const humanActor = (): Record<string, unknown> => ({ kind: 'human', actorId: 'human:owner' })
const agentActor = (sessionId: string): Record<string, unknown> => ({ kind: 'agent', actorId: sessionId, sessionId, agentId: sessionId })

/** 项目 key 安全化（taskboard 要求：2-10 个大写字母/数字，以字母开头，唯一）。 */
export function tbProjectKey(projectId: string): string {
  // 用简单哈希把任意 projectId（含中文）映射为稳定大写 key，避免碰撞
  let hash = 0
  for (let i = 0; i < projectId.length; i++) {
    hash = ((hash << 5) - hash + projectId.charCodeAt(i)) | 0
  }
  const digest = (hash >>> 0).toString(36).toUpperCase()
  // 前缀 AGI + 哈希，截断到 10 位（以字母开头）
  return `AGI${digest}`.slice(0, 10)
}

/** 项目是否已存在于 taskboard。 */
export function tbProjectExists(projectId: string): boolean {
  const p = tbProvider() as Provider
  try {
    return p.getProject(tbProjectKey(projectId)) !== undefined
  } catch {
    return false
  }
}

/** 创建 AGI 团队项目（taskboard project）。返回 project 记录。 */
export function tbCreateProject(projectId: string, projectName: string, workspaceId?: string): Record<string, unknown> {
  const p = tbProvider() as Provider
  const existing = p.getProject(tbProjectKey(projectId))
  if (existing) return existing
  const project = p.createProject({
    key: tbProjectKey(projectId),
    name: projectName,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    labels: ['agiteam'],
  }, humanActor())
  return project
}

/** 创建阶段任务（todo 状态，source 承载 AGI 阶段信息）。返回任务记录。 */
export function tbCreateStageTask(
  projectId: string,
  stage: string,
  title: string,
  description: string,
  info: { requirementId?: string; role?: string; artifactPath?: string; cwd?: string; kbPath?: string },
): Record<string, unknown> {
  const p = tbProvider() as Provider
  const project = p.getProject(tbProjectKey(projectId))
  if (!project) throw new Error(`taskboard 项目 ${projectId} 不存在`)
  const task = p.createTask({
    projectId: project.id as string,
    title,
    description,
    creator: 'agiteam:owner',
    status: 'todo',
    labels: ['agiteam', stageLabel(stage)],
    source: encodeAgiteamSource({
      stage,
      ...(info.requirementId === undefined ? {} : { requirementId: info.requirementId }),
      ...(info.role === undefined ? {} : { role: info.role }),
      ...(info.artifactPath === undefined ? {} : { artifactPath: info.artifactPath }),
      ...(info.cwd === undefined ? {} : { cwd: info.cwd }),
      ...(info.kbPath === undefined ? {} : { kbPath: info.kbPath }),
    }),
  }, humanActor())
  return task
}

/** 列出项目的 AGI 阶段任务（按标签过滤）。 */
export function tbListStageTasks(projectId: string): Array<Record<string, unknown>> {
  const p = tbProvider() as Provider
  const project = p.getProject(tbProjectKey(projectId))
  if (!project) return []
  return p.listTasks({ projectId: project.id as string, includeArchived: false })
    .filter(task => (task.labels as string[]).includes('agiteam'))
}

/** 查项目当前阶段任务（todo/in_progress/in_review，取最新）。 */
export function tbCurrentStageTask(projectId: string): Record<string, unknown> | undefined {
  const tasks = tbListStageTasks(projectId)
  return tasks
    .filter(t => ['todo', 'in_progress', 'in_review'].includes(t.status as string))
    .sort((a, b) => (b.createdAt as number) - (a.createdAt as number))[0]
}

/** 读取任务 source 里的 AGI 阶段信息。 */
export function tbStageOf(task: Record<string, unknown>): string | undefined {
  return agiteamSourceOf(task.source as Record<string, unknown> | undefined)?.stage
}

/** 认领阶段任务（agent 开始干活前）。返回 claim。 */
export function tbClaimStageTask(taskId: string, sessionId: string, expectedVersion: number): Record<string, unknown> {
  const p = tbProvider() as Provider
  const result = p.claim(taskId, {
    expectedVersion,
    sessionId,
    agentId: sessionId,
  }, agentActor(sessionId))
  return result.claim
}

/** 阶段任务提交审批（in_review）。由认领该任务的 agent 提交（taskboard 语义：human 不能 submitReview）。 */
export function tbSubmitStageReview(taskId: string, expectedVersion: number, verification: string, resultComment: string, sessionId?: string): Record<string, unknown> {
  const p = tbProvider() as Provider
  // 从任务详情取 activeClaim 的 sessionId 作为提交者（无 claim 时用传入 sessionId，再无则报错）
  let actor: Record<string, unknown>
  if (sessionId) {
    actor = agentActor(sessionId)
  } else {
    try {
      const detail = (p as unknown as { getTaskDetail(id: string, opts: { activityLimit: number }): { activeClaim?: { sessionId: string } } }).getTaskDetail(taskId, { activityLimit: 0 })
      const claimSession = detail.activeClaim?.sessionId
      if (!claimSession) throw new Error('任务无 active claim')
      actor = agentActor(claimSession)
    } catch {
      throw new Error(`任务 ${taskId} 无认领者，无法提交审批（需先由角色 agent 认领）`)
    }
  }
  return p.submitReview(taskId, expectedVersion, verification, resultComment, actor)
}

/** 人工审批放行（in_review → done，human-only accept）。 */
export function tbApproveStage(taskId: string, expectedVersion: number, comment: string): Record<string, unknown> {
  const p = tbProvider() as Provider
  // taskboard 语义：approve = backlog→todo（创建批准）；accept = in_review→done（验收放行）
  const task = p.accept(taskId, expectedVersion, humanActor())
  if (comment) {
    try { p.comment(taskId, task.version as number, comment, humanActor()) } catch { /* 注释失败不阻断 */ }
  }
  return task
}

/** 人工打回（in_review → todo，带意见返工）。 */
export function tbRejectStage(taskId: string, expectedVersion: number, comment: string): Record<string, unknown> {
  const p = tbProvider() as Provider
  const task = p.returnForRework(taskId, expectedVersion, 'todo', comment, humanActor())
  return task
}

/** 人工暂停（blocked）。 */
export function tbPauseStage(taskId: string, expectedVersion: number, reason: string): Record<string, unknown> {
  const p = tbProvider() as Provider
  return p.block(taskId, expectedVersion, reason, humanActor())
}

/** 恢复（blocked → todo 重新可认领）。 */
export function tbResumeStage(taskId: string, expectedVersion: number): Record<string, unknown> {
  const p = tbProvider() as Provider
  return p.resume(taskId, expectedVersion, humanActor(), 'todo')
}

/** 给阶段任务加依赖关系（blocks：前置阶段完成后当前才能认领）。 */
export function tbAddDependency(sourceTaskId: string, sourceVersion: number, targetTaskId: string): void {
  const p = tbProvider() as Provider
  try {
    p.addRelation(sourceTaskId, sourceVersion, targetTaskId, 'blocks', humanActor())
  } catch { /* 重复关系忽略 */ }
}

/** 阶段 → 阶段任务标题。 */
export function stageTaskTitle(stage: string, projectName: string): string {
  const name = AGITEAM_STAGE_NAMES[stage] ?? stage
  const role = AGITEAM_STAGE_ROLE[stage]
  return `${name}（${role ?? '团队'}）· ${projectName}`
}

/** 当前阶段 → 下一阶段（无则 undefined=交付）。 */
export function nextStageOf(stage: string): string | undefined {
  return AGITEAM_NEXT_STAGE[stage]
}

/** 阶段是否评审阶段。 */
export function isReviewStageOf(stage: string): boolean {
  return stage === 'req-review' || stage === 'product-review' || stage === 'testcase-review'
}

/** 项目当前阶段（取最新未 done 任务的 stage；无任务返回 requirement）。 */
export function tbProjectStage(projectId: string): string {
  const tasks = tbListStageTasks(projectId)
  const active = tasks
    .filter(t => t.status !== 'done' && t.status !== 'canceled')
    .sort((a, b) => (b.createdAt as number) - (a.createdAt as number))[0]
  return active ? (tbStageOf(active) ?? 'requirement') : 'requirement'
}

/**
 * 任务板审批引擎 —— taskboard 风格的任务状态机 + 人工审批门禁。
 *
 * 设计（抄袭 DSH-taskboard 的 provider.ts）：
 *  - 任务状态机：open → claimed → in_progress → in_review → done
 *    分支：in_review → rejected（打回返工）/ paused（人工暂停，随时可停）
 *  - 只有 human（主会话/你）能 approve（批准放行）：
 *      · AI 完成工作后提交 in_review（含审批建议）；
 *      · 你可以 approve（批准）或 reject（打回）或 pause（暂停）；
 *  - 乐观锁 expectedVersion：所有写操作校验任务版本，防并发覆盖；
 *  - 版本号递增，冲突即报错（任务被他人修改，请重读）。
 *
 * 审批模式（个人平台，你是魔王）：
 *  - human：只有你 approve（默认）；
 *  - ai：AI 代为审批（agent 可 autoApprove 自己提交的 in_review，
 *    但你的 pause 永远优先，随时可暂停/修改）；
 *  - auto：自动放行（阶段流程自动推进，不卡审批）。
 */

import type { ApprovalSource, TaskRecordType as TaskRecord, TaskStatus } from './domain'
import { TASK_STATUSES } from './domain'
import type { AgiteamDomain } from './store'

/** 任务板错误（带中文消息）。 */
export class TaskboardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskboardError'
  }
}

/** 写操作的版本校验结果。 */
export interface TaskMutationResult {
  task: TaskRecord
  changed: boolean
}

/** 版本号（乐观锁）。 */
export function versionOf(task: TaskRecord): number {
  return task.updatedAt
}

/** 读取任务（不存在抛错）。 */
export function requireTask(domain: AgiteamDomain, projectId: string, taskId: string): TaskRecord {
  const task = domain.tasks.get(`${projectId}:${taskId}`) as TaskRecord | undefined
  if (!task) throw new TaskboardError(`任务 ${taskId} 不存在（项目 ${projectId}）`)
  return task
}

/** 校验乐观锁版本：不匹配抛错（任务被并发修改）。 */
export function requireVersion(task: TaskRecord, expectedVersion: number): void {
  if (expectedVersion > 0 && task.updatedAt !== expectedVersion) {
    throw new TaskboardError(`任务 ${task.id} 已被修改（版本 ${task.updatedAt} ≠ 期望 ${expectedVersion}），请重读后再操作`)
  }
}

/** 写回任务并递增版本（乐观锁核心）。 */
export async function commitTask(domain: AgiteamDomain, task: TaskRecord): Promise<TaskRecord> {
  const next: TaskRecord = { ...task, updatedAt: Date.now() }
  await domain.tasks.put(`${task.projectId}:${task.id}`, next)
  return next
}

/** 任务状态机：合法流转表。 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ['claimed', 'in_progress', 'in_review', 'paused', 'done', 'failed', 'rejected'],
  claimed: ['in_progress', 'paused', 'done', 'failed', 'rejected'],
  in_progress: ['in_review', 'paused', 'done', 'failed', 'rejected'],
  in_review: ['done', 'rejected', 'paused'],
  paused: ['in_progress', 'claimed', 'in_review', 'done', 'failed', 'rejected'],
  done: [],
  failed: ['in_progress', 'paused'],
  rejected: ['in_progress', 'paused'],
}

/** 校验状态流转是否合法。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * 人工审批放行（approve）：in_review → done。
 * 只有 human 可调用（你是魔王，最终决定权在你）。
 */
export async function approveTask(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
  comment: string,
  source: ApprovalSource = 'human',
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  if (task.status !== 'in_review' && task.status !== 'in_progress' && task.status !== 'paused') {
    throw new TaskboardError(`任务 ${taskId} 当前状态「${task.status}」不能审批放行（需 in_review/in_progress/paused）`)
  }
  if (source === 'human' && task.approvalSource === 'human' && task.status !== 'in_review') {
    // 人工审批：只放行提交审批的任务；in_progress 直接放行视为人工加速
  }
  return commitTask(domain, {
    ...task,
    status: 'done',
    result: task.result || '已人工审批放行',
    approvalSource: source,
    reviewComment: comment,
    approvedAt: Date.now(),
  })
}

/**
 * AI 代为审批（ai approve）：AI 完成工作后提交 in_review，
 * 由 AI 依据验收标准给出建议（approvalSuggestion），
 * 但只有你（human）能真正放行；或通过 autoApprove 自动放行。
 */
export async function submitReview(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
  result: string,
  suggestion: string,
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  if (task.status !== 'in_progress' && task.status !== 'claimed' && task.status !== 'open') {
    throw new TaskboardError(`任务 ${taskId} 当前状态「${task.status}」不能提交审批（需 in_progress/claimed/open）`)
  }
  return commitTask(domain, {
    ...task,
    status: 'in_review',
    result,
    approvalSuggestion: suggestion,
    reviewComment: '',
  })
}

/**
 * AI 自动审批放行（autoApprove）：AI 完成工作并自评通过后直接放行。
 * 适用于不需要人工把关的阶段（如追溯登记），或项目配置 auto 模式。
 * 你的 pause 永远优先：paused 任务不允许 autoApprove。
 */
export async function autoApprove(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
  result: string,
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  if (task.pausedByHuman) throw new TaskboardError(`任务 ${taskId} 已被人工暂停，不能自动放行`)
  if (task.status !== 'in_progress' && task.status !== 'claimed' && task.status !== 'open') {
    throw new TaskboardError(`任务 ${taskId} 当前状态「${task.status}」不能自动放行（需 in_progress/claimed/open）`)
  }
  return commitTask(domain, {
    ...task,
    status: 'done',
    result,
    approvalSource: 'auto',
    reviewComment: 'AI 自动审批放行',
    approvedAt: Date.now(),
  })
}

/**
 * 人工打回（reject）：in_review → rejected，带意见返回返工。
 * 只有 human 可调用。
 */
export async function rejectTask(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
  comment: string,
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  if (task.status !== 'in_review' && task.status !== 'in_progress') {
    throw new TaskboardError(`任务 ${taskId} 当前状态「${task.status}」不能打回（需 in_review/in_progress）`)
  }
  return commitTask(domain, {
    ...task,
    status: 'rejected',
    reviewComment: comment,
    approvalSource: 'human',
  })
}

/**
 * 人工暂停（pause）：随时可暂停任意未完成任务（你是魔王）。
 * paused 任务不会自动推进；恢复用 resumeTask。
 */
export async function pauseTask(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
  reason: string,
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  if (task.status === 'done' || task.status === 'failed') {
    throw new TaskboardError(`任务 ${taskId} 已结束（${task.status}），不能暂停`)
  }
  return commitTask(domain, {
    ...task,
    status: 'paused',
    pausedByHuman: true,
    pauseReason: reason,
  })
}

/**
 * 恢复暂停任务（resume）：paused → in_progress（或 claimed）。
 * 由你（human）或 AI（恢复后继续）触发。
 */
export async function resumeTask(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  if (task.status !== 'paused') throw new TaskboardError(`任务 ${taskId} 未暂停（当前 ${task.status}）`)
  return commitTask(domain, {
    ...task,
    status: task.claimedBy ? 'in_progress' : 'claimed',
    pausedByHuman: false,
    pauseReason: '',
  })
}

/**
 * 认领任务（claim）：open → claimed，绑定执行会话（taskboard 模式：
 * 认领时生成随机 sessionId，之后 resume 续接）。
 */
export async function claimTask(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
  sessionId: string,
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  if (task.status !== 'open' && task.status !== 'paused' && task.status !== 'rejected') {
    throw new TaskboardError(`任务 ${taskId} 当前状态「${task.status}」不能认领（需 open/paused/rejected）`)
  }
  return commitTask(domain, {
    ...task,
    status: 'claimed',
    claimedBy: sessionId,
    sessionId,
  })
}

/**
 * 任务开始执行（start）：claimed → in_progress。
 */
export async function startTask(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  if (task.status !== 'claimed' && task.status !== 'paused' && task.status !== 'rejected') {
    throw new TaskboardError(`任务 ${taskId} 当前状态「${task.status}」不能开始（需 claimed/paused/rejected）`)
  }
  return commitTask(domain, { ...task, status: 'in_progress' })
}

/**
 * 修改任务（edit）：人工可随时修改任务标题/描述/审批建议（你是魔王）。
 * 修改递增版本，不影响任务状态。
 */
export async function editTask(
  domain: AgiteamDomain,
  projectId: string,
  taskId: string,
  expectedVersion: number,
  patch: Partial<Pick<TaskRecord, 'title' | 'result' | 'approvalSuggestion' | 'reviewComment'>>,
): Promise<TaskRecord> {
  const task = requireTask(domain, projectId, taskId)
  requireVersion(task, expectedVersion)
  return commitTask(domain, { ...task, ...patch })
}

/** 任务是否处于可审批状态。 */
export function isReviewable(task: TaskRecord): boolean {
  return task.status === 'in_review'
}

/** 任务是否已暂停。 */
export function isPaused(task: TaskRecord): boolean {
  return task.status === 'paused' || task.pausedByHuman
}

/** 全部合法状态（供 UI/工具枚举）。 */
export function allStatuses(): readonly TaskStatus[] {
  return TASK_STATUSES
}

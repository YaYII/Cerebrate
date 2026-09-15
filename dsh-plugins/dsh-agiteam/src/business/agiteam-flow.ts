/**
 * AGI 团队流程编排（taskboard 底座版）—— 九阶段流程在 taskboard 上的完整落地。
 *
 * 流程（agiteam_start → agiteam_done → agiteam_approve）：
 *  1. 创建 taskboard 项目 + 第一阶段任务（requirement，todo）；
 *  2. 启动角色 agent（HarnessTaskboardWorker.start：随机 sessionId + resume 续接）
 *     → agent 产出产物（requirements.md）→ agiteam_done 提交 in_review；
 *  3. 你 agiteam_approve 放行 → 创建下阶段任务（product）→ 唤醒下角色；
 *     或 agiteam_reject 打回 → 返回 todo 返工；或 agiteam_pause 暂停。
 *
 * 与 taskboard 原生 automation 的关系：AGI 层直接用 worker.start 驱动角色 agent
 * （agentPreset 按阶段角色，引导含阶段产物要求），不依赖定时器——因为 AGI 流程
 * 是"阶段依赖链"（上阶段审批后才开始下阶段），不是"扫描 todo 并发执行"。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  tbProvider,
  tbCreateProject,
  tbCreateStageTask,
  tbListStageTasks,
  tbCurrentStageTask,
  tbStageOf,
  tbClaimStageTask,
  tbSubmitStageReview,
  tbApproveStage,
  tbRejectStage,
  tbPauseStage,
  tbResumeStage,
  tbProjectStage,
  tbAddDependency,
  stageTaskTitle,
  nextStageOf,
  isReviewStageOf,
} from './agiteam-tb'

/** 阶段 → 角色 preset id（与 roles.ts 一致）。 */
const STAGE_PRESET: Record<string, string> = {
  requirement: 'agiteam-requirement',
  'req-review': 'agiteam-req-reviewer',
  product: 'agiteam-product',
  'product-review': 'agiteam-prod-reviewer',
  testcase: 'agiteam-test-designer',
  'testcase-review': 'agiteam-test-designer',
  develop: 'agiteam-developer',
  'feature-accept': 'agiteam-tester',
  'e2e-accept': 'agiteam-tester',
}

/** 阶段 → 角色中文名。 */
const STAGE_ROLE_NAME: Record<string, string> = {
  requirement: '需求分析师',
  'req-review': '需求评审员',
  product: '产品经理',
  'product-review': '产品评审员',
  testcase: '测试设计师',
  'testcase-review': '测试设计师',
  develop: '开发工程师',
  'feature-accept': '测试验收员',
  'e2e-accept': '测试验收员',
}

/** 阶段 → 产物文件名（供引导消息）。 */
const STAGE_ARTIFACT_FILE: Record<string, string> = {
  requirement: 'requirements/requirements.md',
  'req-review': 'requirements/requirements.md',
  product: 'features/features.md',
  'product-review': 'features/features.md',
  testcase: 'testcases/testcases.md',
  'testcase-review': 'testcases/testcases.md',
  develop: 'code/',
  'feature-accept': 'acceptance.md',
  'e2e-accept': 'e2e.md',
}

/** 阶段引导消息（含产物要求 + 完成指令）。 */
export function stageGuidance(projectName: string, stage: string, requirement?: string): string {
  const roleName = STAGE_ROLE_NAME[stage] ?? '对应角色'
  const artifact = STAGE_ARTIFACT_FILE[stage] ?? ''
  const lines = [
    `【AGI 团队】项目「${projectName}」进入阶段：${stageNameOf(stage)}。`,
    `你作为${roleName}，请完成本阶段工作。`,
  ]
  if (requirement) lines.push('', `【原始需求】\n${requirement}`)
  if (artifact) lines.push('', `【本阶段产物】请把成果写入项目目录：${artifact}`)
  if (isReviewStageOf(stage)) {
    lines.push('', '你是评审角色：请审查上一阶段产物，调用 agiteam_review 给出 通过/打回 判定与意见。')
  } else {
    lines.push('', '完成后调用 agiteam_done 提交结果（进入审批，等待 owner 放行）。')
  }
  return lines.join('\n')
}

/** 阶段中文名。 */
function stageNameOf(stage: string): string {
  const names: Record<string, string> = {
    requirement: '需求分析',
    'req-review': '需求评审',
    product: '产品设计',
    'product-review': '产品评审',
    testcase: '测试用例设计',
    'testcase-review': '测试用例评审',
    develop: '正式开发',
    'feature-accept': '逐功能验收',
    'e2e-accept': '端到端验收',
    done: '交付',
  }
  return names[stage] ?? stage
}

/** 从 Cordis ctx 拿 TaskboardService（taskboard 插件注册的服务）。 */
function tbService(ctx: Context): unknown {
  const service = ctx.get('taskboard')
  if (!service) throw new Error('taskboard 服务不可用（确认 @shengsheng/dsh-taskboard 已在 bundle 注册且先于 agiteam 加载）')
  return service
}

/** 启动角色 agent 执行阶段任务（HarnessTaskboardWorker.start）。 */
export async function launchStageAgent(
  ctx: Context,
  projectId: string,
  taskId: string,
  projectName: string,
  stage: string,
  requirement?: string,
  modelRoute?: string,
): Promise<void> {
  const service = tbService(ctx)
  const provider = tbProvider()
  // 从 taskboard 包加载 worker（惰性）
  const { loadTaskboard } = await import('./taskboard-bridge')
  const api = loadTaskboard()
  // 构造 automation rule 作为 worker 配置载体（agentPreset 按阶段角色）
  const presetId = STAGE_PRESET[stage] ?? 'agiteam-requirement'
  const rule = {
    id: `agiteam-${projectId}-${stage}`,
    projectId: (provider as { getProject(k: string): { id: string } }).getProject(
      (await import('./agiteam-tb')).tbProjectKey(projectId),
    ).id,
    config: {
      intervalMs: 30_000,
      agentPreset: presetId,
      ...(modelRoute ? { modelRoute } : {}),
      concurrencyLimit: 1,
      quotaPolicy: 'ignore',
      autoPauseOnEmpty: true,
    },
    state: 'enabled',
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  // worker.start(rule, task)：认领 + 启动角色 agent + 投递引导
  const task = (provider as { getTask(id: string): Record<string, unknown> }).getTask(taskId)
  const worker = new api.HarnessTaskboardWorker(ctx, service as never) as { start(rule: unknown, task: unknown): Promise<void> }
  await worker.start(rule as never, task as never)
}

/** AGI 项目启动：创建项目 + 第一阶段任务 + 启动需求分析师。 */
export async function agiteamStartFlow(
  ctx: Context,
  projectId: string,
  projectName: string,
  requirement: string,
  workspaceId?: string,
  kbPath?: string,
): Promise<{ project: { key: string; id: string }; task: { id: string; identifier: string }; stage: string }> {
  // 先确认 taskboard 服务可用（测试环境/未注册时不可用 → 抛错让上层回退，避免写脏数据）
  const service = ctx.get('taskboard')
  if (!service) throw new Error('taskboard 服务不可用（未注册或未先加载）')
  const project = tbCreateProject(projectId, projectName, workspaceId)
  // 第一阶段任务（requirement，todo）
  const task = tbCreateStageTask(projectId, 'requirement', stageTaskTitle('requirement', projectName), requirement, {
    role: 'requirement',
    ...(STAGE_ARTIFACT_FILE.requirement ? { artifactPath: STAGE_ARTIFACT_FILE.requirement } : {}),
    ...(kbPath ? { kbPath } : {}),
  })
  // 启动需求分析师
  await launchStageAgent(ctx, projectId, task.id as string, projectName, 'requirement', requirement)
  return {
    project: { key: project.key as string, id: project.id as string },
    task: { id: task.id as string, identifier: task.identifier as string },
    stage: 'requirement',
  }
}

/** 阶段完成（agiteam_done）：当前阶段任务提交 in_review。 */
export function agiteamDoneFlow(projectId: string, taskId: string, expectedVersion: number, result: string): { id: string; status: string; title: string } {
  const done = tbSubmitStageReview(taskId, expectedVersion, result, '阶段完成，等待审批')
  return { id: done.id as string, status: done.status as string, title: done.title as string }
}

/** 人工审批放行（agiteam_approve）：in_review → done，创建下阶段任务并唤醒下角色。 */
export async function agiteamApproveFlow(
  ctx: Context,
  projectId: string,
  taskId: string,
  expectedVersion: number,
  projectName: string,
  comment: string,
  kbPath?: string,
): Promise<{ approved: { id: string; status: string; title: string }; nextTask?: { id: string; identifier: string }; nextStage?: string }> {
  const approved = tbApproveStage(taskId, expectedVersion, comment)
  const currentStage = tbStageOf(approved) ?? tbProjectStage(projectId)
  const next = nextStageOf(currentStage)
  if (!next || next === 'done') {
    return { approved: { id: approved.id as string, status: approved.status as string, title: approved.title as string } }
  }
  // 创建下阶段任务
  const role = STAGE_PRESET[next]?.replace('agiteam-', '')
  const nextTask = tbCreateStageTask(projectId, next, stageTaskTitle(next, projectName), '', {
    ...(role ? { role } : {}),
    ...(STAGE_ARTIFACT_FILE[next] ? { artifactPath: STAGE_ARTIFACT_FILE[next] } : {}),
    ...(kbPath ? { kbPath } : {}),
  })
  // AGI 阶段链自动编排：放行任务（done）blocks 下一任务。
  // 语义"评审依赖产物、开发依赖用例评审、验收依赖开发"，coordinator/worker
  // 认领下一任务前必须等本任务 done（已成立），链同时让 UI/甘特图可见依赖，
  // 并在打回重开后防旧并发任务被抢先认领。
  tbAddDependency(approved.id as string, approved.version as number, nextTask.id as string)
  // 启动下阶段角色
  await launchStageAgent(ctx, projectId, nextTask.id as string, projectName, next)
  return {
    approved: { id: approved.id as string, status: approved.status as string, title: approved.title as string },
    nextTask: { id: nextTask.id as string, identifier: nextTask.identifier as string },
    nextStage: next,
  }
}

/** 人工打回（agiteam_reject）：in_review → todo 返工（带意见）。 */
export function agiteamRejectFlow(projectId: string, taskId: string, expectedVersion: number, comment: string): { id: string; status: string; title: string } {
  const rejected = tbRejectStage(taskId, expectedVersion, comment)
  return { id: rejected.id as string, status: rejected.status as string, title: rejected.title as string }
}

/** 人工暂停（agiteam_pause）。 */
export function agiteamPauseFlow(projectId: string, taskId: string, expectedVersion: number, reason: string): { id: string; status: string; title: string } {
  const paused = tbPauseStage(taskId, expectedVersion, reason)
  return { id: paused.id as string, status: paused.status as string, title: paused.title as string }
}

/** 恢复（agiteam_resume）。 */
export function agiteamResumeFlow(projectId: string, taskId: string, expectedVersion: number): { id: string; status: string; title: string } {
  const resumed = tbResumeStage(taskId, expectedVersion)
  return { id: resumed.id as string, status: resumed.status as string, title: resumed.title as string }
}

/** 项目全景（供 agiteam_status 与 UI）。 */
export function agiteamProjectView(projectId: string): {
  projectId: string
  stage: string
  currentTask: { id: string; title: string; status: string; stage: string | undefined; version: number } | undefined
  tasks: Array<{ id: string; identifier: string; title: string; status: string; stage: string | undefined; version: number; createdAt: number }>
} {
  const tasks = tbListStageTasks(projectId)
  const current = tbCurrentStageTask(projectId)
  return {
    projectId,
    stage: tbProjectStage(projectId),
    currentTask: current ? {
      id: current.id as string,
      title: current.title as string,
      status: current.status as string,
      stage: tbStageOf(current),
      version: current.version as number,
    } : undefined,
    tasks: tasks.map(t => ({
      id: t.id as string,
      identifier: t.identifier as string,
      title: t.title as string,
      status: t.status as string,
      stage: tbStageOf(t),
      version: t.version as number,
      createdAt: t.createdAt as number,
    })),
  }
}

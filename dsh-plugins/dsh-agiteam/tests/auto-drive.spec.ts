/**
 * 自动驱动引擎 + 数据库 store 单元测试。
 */

import { describe, expect, it } from 'vitest'
import { autoAdvance, approveStage, pauseStage, rejectStage, reviewDecision, stageGreeting, ensureStageTask, type AutoDriveRuntime } from '../src/business/auto-drive'
import { nextStage, STAGE_NAMES } from '../src/features/stage'
import type { ProjectRecordType } from '../src/business/domain'

/** 内存版域（测试替身，模拟 storageDomain 表）。 */
function memoryDomain() {
  const tables: Record<string, Map<string, unknown>> = {
    projects: new Map(),
    entities: new Map(),
    audit: new Map(),
    tasks: new Map(),
  }
  const domain = {
    handle: { close: async () => {} },
    projects: {
      get: (k: string) => tables.projects!.get(k),
      put: async (k: string, v: unknown) => { tables.projects!.set(k, v) },
      entries: () => tables.projects!.entries(),
    },
    entities: {
      get: (k: string) => tables.entities!.get(k),
      put: async (k: string, v: unknown) => { tables.entities!.set(k, v) },
      entries: () => tables.entities!.entries(),
    },
    audit: {
      get: (k: string) => tables.audit!.get(k),
      put: async (k: string, v: unknown) => { tables.audit!.set(k, v) },
      entries: () => tables.audit!.entries(),
    },
    tasks: {
      get: (k: string) => tables.tasks!.get(k),
      put: async (k: string, v: unknown) => { tables.tasks!.set(k, v) },
      entries: () => tables.tasks!.entries(),
    },
  }
  return { domain, tables }
}

/** 构造测试项目。 */
function makeProject(stage = 'requirement'): ProjectRecordType {
  return {
    id: 'p1',
    name: '测试项目',
    rawRequirement: '用户登录',
    stage,
    completed: {},
    reviewComments: {},
    artifacts: {},
    cwd: '/tmp',
    autoDrive: true,
    currentReqId: '',
    requirements: {},
    ownerSession: '',
    kbPath: '',
    ownerProvider: '',
    ownerModel: '',
    ownerEffort: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** 内存自动驱动运行时（记录唤醒）。exists 默认 true（产物存在）。 */
function memoryRuntime(): AutoDriveRuntime & { woken: string[]; created: string[] } {
  const woken: string[] = []
  const created: string[] = []
  return {
    cwd: '/tmp',
    async wakeRole(projectId, role, text) {
      woken.push(`${projectId}:${role}:${text.slice(0, 20)}`)
      return true
    },
    async createRole(projectId, role, _cwd, greeting) {
      created.push(`${projectId}:${role}:${greeting.slice(0, 20)}`)
    },
    async ensureRole(projectId, role, _cwd, greeting, reqId) {
      const sessionId = `agiteam-test-${role}-${reqId ?? 'none'}`
      created.push(`${projectId}:${role}:${greeting.slice(0, 20)}`)
      return { sessionId, created: true }
    },
    async exists(_absPath) {
      return true
    },
    woken,
    created,
  }
}

describe('自动驱动引擎（agiteam_done 核心）', () => {
  it('阶段完成提交 in_review 等待人工审批（不再自动推进）', async () => {
    const { domain } = memoryDomain()
    const rt = memoryRuntime()
    const project = makeProject('requirement')
    await domain.projects.put('p1', project)
    // 预置当前阶段任务
    await domain.tasks.put('p1:T-1', {
      id: 'T-1', projectId: 'p1', stage: 'requirement', title: '需求分析', role: 'requirement',
      status: 'in_progress', sessionId: '', result: '', approvalSuggestion: '', approvalSource: 'human',
      reviewComment: '', pausedByHuman: false, pauseReason: '', createdAt: Date.now(), updatedAt: Date.now(),
    })

    const next = await autoAdvance({} as never, domain as never, rt, 'p1', '需求清单完成')
    // 任务提交 in_review（等人工审批）
    expect(next.stage).toBe('requirement')
    const task = (await domain.tasks.get('p1:T-1')) as { status: string }
    expect(task.status).toBe('in_review')
  })

  it('评审阶段不能 autoAdvance（必须 reviewDecision）', async () => {
    const { domain } = memoryDomain()
    const rt = memoryRuntime()
    const project = makeProject('req-review')
    await domain.projects.put('p1', project)

    const next = await autoAdvance({} as never, domain as never, rt, 'p1', '评审完成')
    // 评审阶段保持不动
    expect(next.stage).toBe('req-review')
  })

  it('人工审批放行：in_review → done 并推进到下一阶段', async () => {
    const { domain } = memoryDomain()
    const rt = memoryRuntime()
    const project = makeProject('requirement')
    await domain.projects.put('p1', project)
    // 预置 in_review 任务
    await domain.tasks.put('p1:T-1', {
      id: 'T-1', projectId: 'p1', stage: 'requirement', title: '需求分析', role: 'requirement',
      status: 'in_review', sessionId: '', result: '需求清单完成', approvalSuggestion: '', approvalSource: 'human',
      reviewComment: '', pausedByHuman: false, pauseReason: '', createdAt: Date.now(), updatedAt: Date.now(),
    })

    const next = await approveStage({} as never, domain as never, rt, 'p1', '需求完整，放行')
    expect(next.stage).toBe('req-review')
    const task = (await domain.tasks.get('p1:T-1')) as { status: string; approvalSource: string }
    expect(task.status).toBe('done')
    expect(task.approvalSource).toBe('human')
    expect(next.completed.requirement).toBe(true)
    expect(rt.created.some(c => c.startsWith('p1:req-reviewer:'))).toBe(true)
  })

  it('done 阶段：最后一阶段审批后标记交付', async () => {
    const { domain } = memoryDomain()
    const rt = memoryRuntime()
    const project = makeProject('e2e-accept')
    await domain.projects.put('p1', project)
    await domain.tasks.put('p1:T-1', {
      id: 'T-1', projectId: 'p1', stage: 'e2e-accept', title: '端到端验收', role: 'tester',
      status: 'in_review', sessionId: '', result: 'E2E 通过', approvalSuggestion: '', approvalSource: 'human',
      reviewComment: '', pausedByHuman: false, pauseReason: '', createdAt: Date.now(), updatedAt: Date.now(),
    })

    const next = await approveStage({} as never, domain as never, rt, 'p1', '验收通过')
    expect(next.stage).toBe('done')
    expect(next.completed['e2e-accept']).toBe(true)
  })

  it('人工打回：in_review → rejected 并返回上一阶段返工', async () => {
    const { domain } = memoryDomain()
    const rt = memoryRuntime()
    const project = makeProject('requirement')
    await domain.projects.put('p1', project)
    await domain.tasks.put('p1:T-1', {
      id: 'T-1', projectId: 'p1', stage: 'requirement', title: '需求分析', role: 'requirement',
      status: 'in_review', sessionId: '', result: '需求清单完成', approvalSuggestion: '', approvalSource: 'human',
      reviewComment: '', pausedByHuman: false, pauseReason: '', createdAt: Date.now(), updatedAt: Date.now(),
    })

    const next = await rejectStage({} as never, domain as never, rt, 'p1', '需求不完整')
    expect(next.stage).toBe('requirement')
    const task = (await domain.tasks.get('p1:T-1')) as { status: string; reviewComment: string }
    expect(task.status).toBe('rejected')
    expect(task.reviewComment).toBe('需求不完整')
  })

  it('人工暂停：随时暂停当前阶段', async () => {
    const { domain } = memoryDomain()
    const project = makeProject('requirement')
    await domain.projects.put('p1', project)
    await domain.tasks.put('p1:T-1', {
      id: 'T-1', projectId: 'p1', stage: 'requirement', title: '需求分析', role: 'requirement',
      status: 'in_progress', sessionId: '', result: '', approvalSuggestion: '', approvalSource: 'human',
      reviewComment: '', pausedByHuman: false, pauseReason: '', createdAt: Date.now(), updatedAt: Date.now(),
    })

    const next = await pauseStage({} as never, domain as never, 'p1', '需要补充背景')
    expect(next.stage).toBe('requirement')
    const task = (await domain.tasks.get('p1:T-1')) as { status: string; pausedByHuman: boolean }
    expect(task.status).toBe('paused')
    expect(task.pausedByHuman).toBe(true)
  })

  it('评审通过：前进到下一阶段', async () => {
    const { domain } = memoryDomain()
    const rt = memoryRuntime()
    const project = makeProject('req-review')
    await domain.projects.put('p1', project)

    const next = await reviewDecision({} as never, domain as never, rt, 'p1', true, '需求完整')
    expect(next.stage).toBe('product')
    expect(rt.created.some(c => c.startsWith('p1:product:'))).toBe(true)
  })

  it('评审通过但产物不存在：拒绝通过（防无产物空转）', async () => {
    const { domain } = memoryDomain()
    const rt = memoryRuntime()
    rt.exists = async () => false  // 模拟上一阶段产物缺失
    const project = makeProject('req-review')
    await domain.projects.put('p1', project)

    await expect(reviewDecision({} as never, domain as never, rt, 'p1', true, '需求完整'))
      .rejects.toThrow(/产物不存在/)
    // 阶段保持原状（未被推进）
    const after = (await domain.projects.get('p1')) as unknown as { stage: string }
    expect(after.stage).toBe('req-review')
  })

  it('评审打回：返回上一阶段并带意见', async () => {
    const { domain } = memoryDomain()
    const rt = memoryRuntime()
    const project = makeProject('req-review')
    await domain.projects.put('p1', project)

    const next = await reviewDecision({} as never, domain as never, rt, 'p1', false, '需求不完整')
    expect(next.stage).toBe('requirement')
    expect(next.reviewComments['req-review']).toContain('需求不完整')
    expect(rt.created.some(c => c.startsWith('p1:requirement:'))).toBe(true)
  })

  it('阶段引导消息包含 agiteam_done 指令', () => {
    const project = makeProject('requirement')
    const msg = stageGreeting(project, 'requirement')
    expect(msg).toContain('需求分析')
    expect(msg).toContain('agiteam_done')
  })
})

describe('阶段任务创建', () => {
  it('为阶段创建任务（含角色）', async () => {
    const { domain } = memoryDomain()
    const project = makeProject('requirement')
    await domain.projects.put('p1', project)

    const task = await ensureStageTask(domain as never, project, 'requirement')
    expect(task).toBeTruthy()
    expect(task!.role).toBe('requirement')
    expect(task!.stage).toBe('requirement')
    expect(task!.status).toBe('open')
  })

  it('已有 open 任务则复用', async () => {
    const { domain, tables } = memoryDomain()
    const project = makeProject('requirement')
    await domain.projects.put('p1', project)
    tables.tasks!.set('p1:T-1', {
      id: 'T-1', projectId: 'p1', stage: 'requirement', title: '需求分析', role: 'requirement',
      status: 'open', result: '', createdAt: Date.now(), updatedAt: Date.now(),
    })

    const task = await ensureStageTask(domain as never, project, 'requirement')
    expect(task!.id).toBe('T-1')
  })
})

describe('阶段状态机一致性', () => {
  it('自动驱动链完整：requirement → done', () => {
    const chain = ['requirement', 'req-review', 'product', 'product-review', 'testcase', 'testcase-review', 'develop', 'feature-accept', 'e2e-accept', 'done']
    let current = chain[0]!
    const walked = [current]
    while (true) {
      const next = nextStage(current as never)
      if (!next) break
      walked.push(next)
      current = next
    }
    expect(walked).toEqual(chain)
    // 每阶段有中文名
    for (const s of walked) expect(STAGE_NAMES[s as keyof typeof STAGE_NAMES]).toBeTruthy()
  })
})

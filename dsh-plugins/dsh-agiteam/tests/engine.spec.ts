/**
 * 渲染砖块与引擎流转单元测试 —— 验证文档渲染与状态推进。
 */

import { describe, expect, it } from 'vitest'
import { renderFeatures, renderRequirements, renderTestcases } from '../src/features/render'
import type { FeaturesDoc, RequirementsDoc, TestcasesDoc } from '../src/features/model'
import { parseAuditLog, makeAuditEntry } from '../src/features/audit'
import {
  advanceAndWake,
  advanceStage,
  emptyState,
  recordReviewComment,
  type EngineRuntime,
} from '../src/business/engine'

/** 内存版引擎运行时（测试替身，无真实 fs/agent），附带观察记录便于断言。 */
interface MemoryRuntime extends EngineRuntime {
  _files: Map<string, string>
  _woken: string[]
  _created: string[]
}

/** 构造内存版引擎运行时（测试替身，无真实 fs/agent）。 */
function memoryRuntime(): MemoryRuntime {
  const files = new Map<string, string>()
  const woken: string[] = []
  const created: string[] = []
  return {
    async readText(rel) { return files.get(rel) },
    async writeText(rel, content) { files.set(rel, content) },
    async exists(rel) { return files.has(rel) },
    async listDir() { return [...files.keys()] },
    async createRoleAgent(projectId, role, _cwd, greeting) {
      created.push(`${projectId}:${role}:${greeting.slice(0, 30)}`)
      return { sessionId: `session-${projectId}-${role}` }
    },
    async wakeRoleAgent(projectId, role, text) {
      woken.push(`${projectId}:${role}:${text.slice(0, 30)}`)
      return true
    },
    async appendAudit(input) {
      const auditFile = `${input.projectId}/audit.jsonl`
      const text = files.get(auditFile)
      const entries = text ? parseAuditLog(text) : []
      const prevHash = entries.length > 0 ? entries[entries.length - 1]!.hash : 'GENESIS'
      const entry = makeAuditEntry(entries.length + 1, {
        time: Date.now(),
        action: input.action,
        role: input.role,
        projectId: input.projectId,
        stage: input.stage,
        detail: input.detail,
        ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
      }, prevHash)
      const nextText = text ? `${text}\n${JSON.stringify(entry)}` : JSON.stringify(entry)
      files.set(auditFile, nextText)
      return { seq: entry.seq, hash: entry.hash }
    },
    _files: files,
    _woken: woken,
    _created: created,
  }
}

describe('渲染砖块', () => {
  it('需求清单渲染包含编号/标题/优先级/验收标准', () => {
    const doc: RequirementsDoc = {
      projectName: '测试项目',
      background: '背景',
      items: [
        { id: 'R-1', title: '登录', detail: '用户可登录', priority: 'P0', acceptance: '输入正确账号密码可登录' },
      ],
    }
    const md = renderRequirements(doc)
    expect(md).toContain('# 需求清单：测试项目')
    expect(md).toContain('R-1')
    expect(md).toContain('P0')
    expect(md).toContain('输入正确账号密码可登录')
  })

  it('产品功能清单渲染包含功能/关联需求/API', () => {
    const doc: FeaturesDoc = {
      projectName: '测试项目',
      items: [
        { id: 'F-1', name: '登录功能', requirementIds: ['R-1'], description: '登录', userFlow: '输入→提交', apiEndpoints: ['POST /login'] },
      ],
    }
    const md = renderFeatures(doc)
    expect(md).toContain('# 产品功能清单：测试项目')
    expect(md).toContain('F-1')
    expect(md).toContain('POST /login')
  })

  it('测试用例矩阵渲染包含功能↔用例关联', () => {
    const doc: TestcasesDoc = {
      projectName: '测试项目',
      cases: [
        { id: 'TC-1', featureId: 'F-1', title: '登录成功', preconditions: '已注册', steps: ['输入', '提交'], expected: '进入首页', kind: 'api' },
      ],
      byFeature: { 'F-1': ['TC-1'] },
    }
    const md = renderTestcases(doc)
    expect(md).toContain('# 测试用例矩阵：测试项目')
    expect(md).toContain('TC-1')
    expect(md).toContain('F-1')
  })
})

describe('引擎流转', () => {
  it('空状态从 requirement 开始', () => {
    const state = emptyState('p1', '项目', '需求', '/tmp')
    expect(state.stage).toBe('requirement')
    expect(state.completed).toEqual({})
  })

  it('advanceStage 通过时进入下一阶段', () => {
    const state = emptyState('p1', '项目', '需求', '/tmp')
    expect(advanceStage(state, true)).toBe('req-review')
    expect(state.stage).toBe('req-review')
  })

  it('评审不通过时打回上一阶段', () => {
    const state = emptyState('p1', '项目', '需求', '/tmp')
    state.stage = 'req-review'
    expect(advanceStage(state, false)).toBe('requirement')
    expect(state.stage).toBe('requirement')
  })

  it('非评审阶段不通过时仍前进（无打回目标）', () => {
    const state = emptyState('p1', '项目', '需求', '/tmp')
    state.stage = 'requirement'
    expect(advanceStage(state, false)).toBe('req-review')
  })

  it('记录评审意见', async () => {
    const state = emptyState('p1', '项目', '需求', '/tmp')
    await recordReviewComment(state, 'req-review', '需求不完整')
    await recordReviewComment(state, 'req-review', '缺验收标准')
    expect(state.reviewComments['req-review']).toEqual(['需求不完整', '缺验收标准'])
  })

  it('advanceAndWake 打回后唤醒上一阶段角色', async () => {
    const rt = memoryRuntime()
    const state = emptyState('p1', '项目', '需求', '/tmp')
    state.stage = 'req-review'
    await advanceAndWake(rt, state, false, '需求不完整')
    expect(state.stage).toBe('requirement')
    // 打回 requirement → 唤醒需求分析师
    expect(rt._woken.some(w => w.startsWith('p1:requirement:'))).toBe(true)
  })

  it('advanceAndWake 通过后进入下一阶段并唤醒对应角色', async () => {
    const rt = memoryRuntime()
    const state = emptyState('p1', '项目', '需求', '/tmp')
    await advanceAndWake(rt, state, true)
    expect(state.stage).toBe('req-review')
    // req-review → 唤醒需求评审员
    expect(rt._woken.some(w => w.startsWith('p1:req-reviewer:'))).toBe(true)
  })
})

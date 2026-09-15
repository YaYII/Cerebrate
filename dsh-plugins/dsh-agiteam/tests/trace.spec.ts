/**
 * 审计日志 + 追溯矩阵 + 多层校验 单元测试。
 */

import { describe, expect, it } from 'vitest'
import {
  entryHash,
  makeAuditEntry,
  parseAuditLog,
  verifyAuditChain,
  verifyEntryHash,
} from '../src/features/audit'
import type { AuditEntry } from '../src/features/model'
import { buildTraceRows, traceAllPassed } from '../src/features/trace'
import { verifyProject } from '../src/features/verify'
import type {
  AcceptanceScriptItem,
  CodeFileItem,
  FeatureItem,
  RequirementItem,
  TestCase,
  UnitTestItem,
} from '../src/features/model'

/** 构造一条审计条目的公共字段。 */
function baseEntry(seq: number, prevHash: string): Omit<AuditEntry, 'seq' | 'prevHash' | 'hash'> {
  return {
    time: 1000 + seq,
    action: 'test',
    role: 'tester',
    projectId: 'p1',
    stage: 'develop',
    detail: `动作 ${seq}`,
  }
}

describe('审计日志（sha256 链式防篡改）', () => {
  it('构造条目并校验 hash 自洽', () => {
    const e = makeAuditEntry(1, baseEntry(1, 'GENESIS'), 'GENESIS')
    expect(verifyEntryHash(e)).toBe(true)
    expect(e.hash).toHaveLength(64)
  })

  it('篡改 detail 后 hash 校验失败', () => {
    const e = makeAuditEntry(1, baseEntry(1, 'GENESIS'), 'GENESIS')
    const tampered = { ...e, detail: '被篡改' }
    expect(verifyEntryHash(tampered)).toBe(false)
  })

  it('链式校验：整链完整返回 -1', () => {
    const e1 = makeAuditEntry(1, baseEntry(1, 'GENESIS'), 'GENESIS')
    const e2 = makeAuditEntry(2, baseEntry(2, e1.hash), e1.hash)
    const e3 = makeAuditEntry(3, baseEntry(3, e2.hash), e2.hash)
    expect(verifyAuditChain([e1, e2, e3])).toBe(-1)
  })

  it('链式校验：篡改中间条目导致后继断裂', () => {
    const e1 = makeAuditEntry(1, baseEntry(1, 'GENESIS'), 'GENESIS')
    const e2 = makeAuditEntry(2, baseEntry(2, e1.hash), e1.hash)
    const e3 = makeAuditEntry(3, baseEntry(3, e2.hash), e2.hash)
    const tampered2 = { ...e2, detail: '被篡改' }
    // e2 hash 校验失败 → 断裂位置 1
    expect(verifyAuditChain([e1, tampered2, e3])).toBe(1)
  })

  it('JSONL 序列化往返一致', () => {
    const e1 = makeAuditEntry(1, baseEntry(1, 'GENESIS'), 'GENESIS')
    const e2 = makeAuditEntry(2, baseEntry(2, e1.hash), e1.hash)
    const text = [e1, e2].map(e => JSON.stringify(e)).join('\n')
    const parsed = parseAuditLog(text)
    expect(parsed).toHaveLength(2)
    expect(verifyAuditChain(parsed)).toBe(-1)
  })
})

describe('追溯矩阵', () => {
  const requirements: RequirementItem[] = [
    { id: 'R-1', title: '用户登录', detail: '用户可登录', priority: 'P0', acceptance: '可登录' },
  ]
  const features: FeatureItem[] = [
    { id: 'F-1', name: '登录功能', requirementIds: ['R-1'], description: '登录', userFlow: '输入→提交', apiEndpoints: ['POST /login'] },
  ]
  const testcases: TestCase[] = [
    { id: 'TC-1', featureId: 'F-1', title: '登录成功', preconditions: '已注册', steps: ['输入'], expected: '进入首页', kind: 'api' },
  ]
  const unitTests: UnitTestItem[] = [
    { id: 'UT-1', testCaseId: 'TC-1', title: '登录单测', filePath: 'tests/login.spec.ts', status: 'passed' },
  ]
  const codeFiles: CodeFileItem[] = [
    { id: 'CF-1', featureId: 'F-1', path: 'src/login.ts', sha256: 'abc', updatedAt: 1, lines: 10 },
  ]
  const scripts: AcceptanceScriptItem[] = [
    { id: 'AS-1', featureId: 'F-1', path: 'scripts/accept-login.sh', kind: 'api', status: 'passed', logFile: 'logs/accept-login.log', ranAt: 1, exitCode: 0 },
  ]

  it('组装追溯矩阵：一行含需求/功能/用例/单测/代码/脚本', () => {
    const rows = buildTraceRows(requirements, features, testcases, unitTests, codeFiles, scripts)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.requirementId).toBe('R-1')
    expect(row.featureId).toBe('F-1')
    expect(row.testCaseIds).toEqual(['TC-1'])
    expect(row.unitTestIds).toEqual(['UT-1'])
    expect(row.codeFiles).toEqual(['src/login.ts'])
    expect(row.acceptanceScripts).toEqual(['scripts/accept-login.sh'])
    expect(row.status).toBe('passed')
    expect(traceAllPassed(rows)).toBe(true)
  })

  it('脚本未通过 → 行状态 failed', () => {
    const badScripts = [{ ...scripts[0]!, status: 'failed' as const }]
    const rows = buildTraceRows(requirements, features, testcases, unitTests, codeFiles, badScripts)
    expect(rows[0]!.status).toBe('failed')
    expect(traceAllPassed(rows)).toBe(false)
  })
})

describe('多层校验（防 AI 幻觉）', () => {
  const requirements: RequirementItem[] = [
    { id: 'R-1', title: '用户登录', detail: '可登录', priority: 'P0', acceptance: '可登录' },
  ]
  const features: FeatureItem[] = [
    { id: 'F-1', name: '登录功能', requirementIds: ['R-1'], description: '登录', userFlow: '输入', apiEndpoints: [] },
  ]
  const testcases: TestCase[] = [
    { id: 'TC-1', featureId: 'F-1', title: '登录成功', preconditions: '', steps: [], expected: '', kind: 'api' },
  ]
  const unitTests: UnitTestItem[] = [
    { id: 'UT-1', testCaseId: 'TC-1', title: '登录单测', filePath: 'tests/login.spec.ts', status: 'passed' },
  ]
  const codeFiles: CodeFileItem[] = [
    { id: 'CF-1', featureId: 'F-1', path: 'src/login.ts', sha256: 'abc', updatedAt: 1, lines: 10 },
  ]
  const scripts: AcceptanceScriptItem[] = [
    { id: 'AS-1', featureId: 'F-1', path: 'scripts/accept-login.sh', kind: 'api', status: 'passed', logFile: 'logs/accept-login.log', ranAt: 1, exitCode: 0 },
  ]

  it('全部满足 → 三层校验通过', async () => {
    const result = await verifyProject(
      requirements, features, testcases, unitTests, codeFiles, scripts, [],
      async () => true, async () => true,
    )
    expect(result.allPass).toBe(true)
    expect(result.mathPass).toBe(true)
    expect(result.scriptPass).toBe(true)
    expect(result.logPass).toBe(true)
  })

  it('功能缺用例 → 数学层失败', async () => {
    const result = await verifyProject(
      requirements, features, [], unitTests, codeFiles, scripts, [],
      async () => true, async () => true,
    )
    expect(result.mathPass).toBe(false)
    expect(result.allPass).toBe(false)
  })

  it('验收脚本文件不存在 → 脚本层失败', async () => {
    const result = await verifyProject(
      requirements, features, testcases, unitTests, codeFiles, scripts, [],
      async (path) => path !== 'scripts/accept-login.sh', async () => true,
    )
    expect(result.scriptPass).toBe(false)
    expect(result.allPass).toBe(false)
  })

  it('审计链断裂 → 日志层失败', async () => {
    const e1 = makeAuditEntry(1, baseEntry(1, 'GENESIS'), 'GENESIS')
    const tampered = { ...e1, detail: '被篡改' }
    const result = await verifyProject(
      requirements, features, testcases, unitTests, codeFiles, scripts, [tampered],
      async () => true, async () => true,
    )
    expect(result.logPass).toBe(false)
    expect(result.allPass).toBe(false)
  })

  it('验收脚本无日志文件 → 日志层失败', async () => {
    const noLogScript = { ...scripts[0]! }
    delete noLogScript.logFile
    const result = await verifyProject(
      requirements, features, testcases, unitTests, codeFiles, [noLogScript], [],
      async () => true, async () => true,
    )
    expect(result.logPass).toBe(false)
    expect(result.allPass).toBe(false)
  })
})

describe('审计条目哈希独立性', () => {
  it('entryHash 忽略 hash 字段（防自指）', () => {
    const e = makeAuditEntry(1, baseEntry(1, 'GENESIS'), 'GENESIS')
    const { hash: _ignored, ...rest } = e
    expect(entryHash(rest)).toBe(entryHash(e))
  })
})

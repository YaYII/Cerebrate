/**
 * agiteam_register / agiteam_run_acceptance 工具单元测试。
 */

import { describe, expect, it } from 'vitest'
import { executeRegister, executeRunAcceptance, executeStartProject } from '../src/business/tools'
import { parseAuditLog } from '../src/features/audit'
import type { Context } from '@deepseek-ai/cordis'
import type { AgiteamConfig } from '../src/business/engine'

/** 构造内存版 Context（fs 用 Map 模拟，agents/agentPresets 最小实现）。 */
function memoryContext(): Context & { _files: Map<string, string> } {
  const files = new Map<string, string>()
  // 模拟 dsh-fs 契约：resolve(path) → {targetKey, displayPath}，其余方法收 target
  const fakeFs = {
    async resolve(path: string) { return { targetKey: `k:${path}`, displayPath: path } },
    async readText(target: { displayPath: string }) { return files.get(target.displayPath) },
    async writeText(target: { displayPath: string }, content: string) { files.set(target.displayPath, content) },
    async stat(target: { displayPath: string }) { return files.has(target.displayPath) ? { type: 'file', version: 'v1', size: 1 } : undefined },
    async listDir() { return [] },
  }
  return {
    get(name: string) {
      if (name === 'fs') return fakeFs
      if (name === 'agents') return {
        create: async () => ({ agent: { session: { id: 'x' }, followup: () => {} } }),
        get: () => undefined,
      }
      if (name === 'agentPresets') return { resolve: async () => ({ id: 'x' }), mount: async () => {} }
      return undefined
    },
    _files: files,
  } as unknown as Context & { _files: Map<string, string> }
}

const config: AgiteamConfig = { artifactsDir: '.teamdev', injectGuidance: false }

describe('agiteam_register（登记追溯实体）', () => {
  it('登记需求 → 写入审计日志（含 hash 指纹）', async () => {
    const ctx = memoryContext()
    // 先建项目
    await executeStartProject(ctx, config, { projectName: '测试项目', requirement: '用户登录', cwd: '/tmp' })

    const result = await executeRegister(ctx, config, {
      projectId: '测试项目',
      role: 'requirement',
      stage: 'requirement',
      action: 'register-requirement',
      detail: JSON.stringify({ id: 'R-1', title: '用户登录', priority: 'P0' }),
      cwd: '/tmp',
    })
    expect(result.status).toBe('ok')
    expect(result.seq).toBe(1)
    expect(typeof result.hash).toBe('string')
    expect(result.hash).toHaveLength(64)

    // 验证审计日志落盘
    const auditText = await ctx._files.get('/tmp/测试项目/audit.jsonl')
    expect(auditText).toBeTruthy()
    const entries = parseAuditLog(auditText!)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.action).toBe('register-requirement')
    expect(entries[0]!.role).toBe('requirement')
  })

  it('action 非法 → 报错', async () => {
    const ctx = memoryContext()
    const result = await executeRegister(ctx, config, {
      projectId: 'x', role: 'a', stage: 's', action: 'bad-action', detail: '{}', cwd: '/tmp',
    })
    expect(result.status).toBe('error')
  })

  it('detail 非 JSON → 报错', async () => {
    const ctx = memoryContext()
    const result = await executeRegister(ctx, config, {
      projectId: 'x', role: 'a', stage: 's', action: 'register-requirement', detail: 'not-json', cwd: '/tmp',
    })
    expect(result.status).toBe('error')
  })
})

describe('agiteam_run_acceptance（执行验收脚本）', () => {
  it('执行真实命令 + 记录日志 + 登记审计', async () => {
    const ctx = memoryContext()
    await executeStartProject(ctx, config, { projectName: '测试项目', requirement: '用户登录', cwd: '/tmp' })

    const result = await executeRunAcceptance(ctx, config, {
      projectId: '测试项目',
      role: 'tester',
      stage: 'feature-accept',
      scriptId: 'AS-1',
      featureId: 'F-1',
      path: 'scripts/accept-login.sh',
      kind: 'api',
      command: 'echo',
      argsList: ['hello'],
      cwd: '/tmp',
    })
    expect(result.status).toBe('ok')
    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(typeof result.logFile).toBe('string')
    expect(result.logFile).toContain('logs/AS-1')

    // 日志文件落盘
    const logContent = ctx._files.get(`/tmp/${result.logFile}`)
    expect(logContent).toContain('hello')
    expect(logContent).toContain('退出码: 0')

    // 审计登记了 register-script
    const auditText = ctx._files.get('/tmp/测试项目/audit.jsonl')
    const entries = parseAuditLog(auditText!)
    const scriptEntries = entries.filter(e => e.action === 'register-script')
    expect(scriptEntries.length).toBeGreaterThanOrEqual(1)
    const detail = JSON.parse(scriptEntries[0]!.detail)
    expect(detail.status).toBe('passed')
    expect(detail.logFile).toContain('logs/AS-1')
  })

  it('命令失败 → passed=false + 记录失败状态', async () => {
    const ctx = memoryContext()
    await executeStartProject(ctx, config, { projectName: '测试项目', requirement: '用户登录', cwd: '/tmp' })

    const result = await executeRunAcceptance(ctx, config, {
      projectId: '测试项目',
      role: 'tester',
      stage: 'feature-accept',
      scriptId: 'AS-2',
      featureId: 'F-1',
      path: 'scripts/fail.sh',
      kind: 'script',
      command: 'node',
      argsList: ['-e', 'process.exit(1)'],
      cwd: '/tmp',
    })
    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(1)

    const auditText = ctx._files.get('/tmp/测试项目/audit.jsonl')
    const entries = parseAuditLog(auditText!)
    const scriptEntries = entries.filter(e => e.action === 'register-script')
    const detail = JSON.parse(scriptEntries.at(-1)!.detail)
    expect(detail.status).toBe('failed')
  })
})

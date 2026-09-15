// 端到端验证（真实文件系统）：角色登记 → 追溯矩阵 → 三层校验 全闭环
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeStartProject, executeRegister, executeRunAcceptance } from '../src/business/tools.ts'
import { buildTraceSnapshot } from '../src/business/web.ts'
import { runtimeFromCtx } from '../src/business/engine.ts'

const cwd = mkdtempSync(join(tmpdir(), 'agiteam-e2e-'))
const files = {} // 内存 fs（模拟 dsh fs 服务，但脚本文件写真实磁盘）
const ctx = {
  get(name) {
    if (name === 'fs') return {
      readText: async ({ path }) => {
        // 真实文件优先，内存兜底
        try { return readFileSync(path, 'utf8') } catch { return files[path] }
      },
      writeText: async ({ path, content }) => {
        try { mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true }); writeFileSync(path, content) } catch { files[path] = content }
      },
      stat: async ({ path }) => {
        try { return { size: readFileSync(path).length } } catch { return files[path] ? { size: 1 } : undefined }
      },
      listDir: async () => [],
    }
    if (name === 'agents') return { create: async () => ({ agent: { session: { id: 'x' }, followup: () => {} } }), get: () => undefined }
    if (name === 'agentPresets') return { resolve: async () => ({ id: 'x' }), mount: async () => {} }
    return undefined
  }
}
const config = { artifactsDir: '.teamdev', injectGuidance: false }

await executeStartProject(ctx, config, { projectName: '登录系统', requirement: '用户登录功能', cwd })
await executeRegister(ctx, config, { projectId: '登录系统', role: 'requirement', stage: 'requirement', action: 'register-requirement', detail: JSON.stringify({ id: 'R-1', title: '用户登录', priority: 'P0' }), cwd })
await executeRegister(ctx, config, { projectId: '登录系统', role: 'product', stage: 'product', action: 'register-feature', detail: JSON.stringify({ id: 'F-1', name: '登录功能', requirementIds: ['R-1'] }), cwd })
await executeRegister(ctx, config, { projectId: '登录系统', role: 'test-designer', stage: 'testcase', action: 'register-testcase', detail: JSON.stringify({ id: 'TC-1', featureId: 'F-1', title: '登录成功', kind: 'api' }), cwd })
await executeRegister(ctx, config, { projectId: '登录系统', role: 'developer', stage: 'develop', action: 'register-codefile', detail: JSON.stringify({ id: 'CF-1', featureId: 'F-1', path: 'src/login.ts' }), cwd })
await executeRegister(ctx, config, { projectId: '登录系统', role: 'developer', stage: 'develop', action: 'register-unittest', detail: JSON.stringify({ id: 'UT-1', testCaseId: 'TC-1', title: '登录单测', filePath: 'tests/login.spec.ts', status: 'passed' }), cwd })
mkdirSync(join(cwd, 'scripts'), { recursive: true })
writeFileSync(join(cwd, 'scripts/accept-login.sh'), '#!/bin/sh\necho 登录成功\n')
const run = await executeRunAcceptance(ctx, config, {
  projectId: '登录系统', role: 'tester', stage: 'feature-accept',
  scriptId: 'AS-1', featureId: 'F-1', path: 'scripts/accept-login.sh', kind: 'api',
  command: 'echo', argsList: ['登录成功'], cwd,
})
console.log('验收执行:', run.message, '| 日志:', run.logFile)

const rt = runtimeFromCtx(ctx, cwd)
const snapshot = await buildTraceSnapshot(rt, '登录系统')
for (const row of snapshot.traceRows) {
  console.log(`需求 ${row.requirementId}(${row.requirementTitle}) → 功能 ${row.featureId}(${row.featureName}) → 用例 [${row.testCaseIds}] → 单测 [${row.unitTestIds}] → 代码 [${row.codeFiles}] → 脚本 [${row.acceptanceScripts}] → 状态: ${row.status}`)
}
console.log('数学层:', snapshot.verification.mathPass ? '✅' : '❌', '| 脚本层:', snapshot.verification.scriptPass ? '✅' : '❌', '| 日志层:', snapshot.verification.logPass ? '✅' : '❌')
console.log('审计条数:', snapshot.auditLog.length, '| 末条 hash:', snapshot.auditLog.at(-1)?.hash.slice(0, 12))
console.log('=== 结果:', snapshot.verification.mathPass && snapshot.verification.scriptPass && snapshot.verification.logPass ? '三层校验全部通过 ✓' : '未通过')

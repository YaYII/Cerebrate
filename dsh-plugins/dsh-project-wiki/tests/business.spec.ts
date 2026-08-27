/**
 * business 层工具实现单元测试——executeWikiWrite/Build/Evolve/Status 全路径。
 *
 * business 层是编排层：execute 函数注入真实文件系统（tmp 项目/vault）+ 假
 * ctx（agents 注册表可替换），逐分支实测：
 *  - executeWikiWrite：缺参校验 / 成功落盘 / Mermaid 清洗警告 / git 提交成功与跳过
 *  - executeWikiBuild：预建快照（中断续传地基）/ 子代理成功 / 注册表缺失报错
 *  - executeWikiEvolve：无变化零开销 / 有变化刷新快照 / 失败保留旧快照
 *  - executeWikiStatus：快照同步时 synced=true
 *  - buildImpls：六工具装配完整性
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { executeWikiWrite } from '../src/business/impls-write'
import { executeWikiEvolve } from '../src/business/impls-evolve'
import { executeWikiBuild, executeWikiStatus, buildImpls } from '../src/business/impls'
import { scanProject } from '../src/features/scanner'
import { loadWikiMeta, saveWikiMeta } from '../src/features/evolve'

/** 构造只提供 agents 注册表的假 ctx。 */
function fakeCtx(agents: unknown): Context {
  return { get: (name: string) => (name === 'agents' ? agents : undefined) } as unknown as Context
}

/** 构造假 AgentHandle：events 可注入（决定 extractOutcome 的报告与错误）。 */
function fakeHandle(events: unknown[]) {
  return {
    agent: {
      session: { events },
      followup: () => {},
      whenIdle: async () => {},
    },
    dispose: async () => {},
  }
}

/** 临时项目：backend/frontend 两个模块 + 根 README。 */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bizproj-'))
  mkdirSync(join(dir, 'backend', 'src'), { recursive: true })
  mkdirSync(join(dir, 'frontend', 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  writeFileSync(join(dir, 'backend', 'src', 'App.java'), 'class App {}')
  writeFileSync(join(dir, 'frontend', 'src', 'main.ts'), 'export const x = 1')
  return dir
}

/** 临时 vault（可选 git init）。 */
function makeVault(withGit: boolean): string {
  const vault = mkdtempSync(join(tmpdir(), 'bizvault-'))
  if (withGit) {
    execFileSync('git', ['init'], { cwd: vault, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: vault, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: vault, stdio: 'ignore' })
  }
  return vault
}

const CFG = { vaultDir: '', kbRoot: '项目知识库' }

describe('executeWikiWrite（落盘业务全路径）', () => {
  it('缺参时返回中文错误（project/path/body 必填）', async () => {
    const vault = makeVault(false)
    CFG.vaultDir = vault
    try {
      const r1 = await executeWikiWrite(CFG, { project: '', path: 'a.md', body: 'x' })
      expect(r1.status).toBe('error')
      expect(r1.message).toContain('project/path/body 必填')
      const r2 = await executeWikiWrite(CFG, { project: 'p', path: '', body: 'x' })
      expect(r2.status).toBe('error')
      const r3 = await executeWikiWrite(CFG, { project: 'p', path: 'a.md', body: '' })
      expect(r3.status).toBe('error')
    } finally { rmSync(vault, { recursive: true, force: true }) }
  })

  it('成功落盘：写入页面 + 返回结构完整（非 git vault 不提交）', async () => {
    const vault = makeVault(false)
    const source = makeProject()
    CFG.vaultDir = vault
    try {
      const r = await executeWikiWrite(CFG, { project: 'demo', path: '02-后端/README.md', body: '# 后端\n\n正文', source })
      expect(r.status).toBe('ok')
      const data = r.data as Record<string, unknown>
      expect(data.written).toBe(true)
      expect(data.committed).toBe(false) // 非 git vault：无提交能力
      expect(data.vaultHead).toBe('')
      expect(data.dir).toContain('demo')
      expect(data.warnings).toBeUndefined() // 干净正文零警告
      const abs = join(join(vault, '项目知识库', 'demo'), '02-后端/README.md')
      expect(existsSync(abs)).toBe(true)
      expect(readFileSync(abs, 'utf8')).toContain('git_head: n/a') // 非 git source → n/a
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(source, { recursive: true, force: true })
    }
  })

  it('Mermaid 风险内容清洗并返回警告（写入前校验链路）', async () => {
    const vault = makeVault(false)
    CFG.vaultDir = vault
    try {
      const r = await executeWikiWrite(CFG, { project: 'demo', path: 'a.md', body: '```mermaid\nflowchart TD\n  A[mpay:nonce:{nonce}]\n```' })
      expect(r.status).toBe('ok')
      const data = r.data as Record<string, unknown>
      expect((data.warnings as string[]).some(w => w.includes('mermaid'))).toBe(true)
      // 写入的文件里花括号已被清洗（R3）
      const abs = join(join(vault, '项目知识库', 'demo'), 'a.md')
      expect(readFileSync(abs, 'utf8')).not.toContain('{nonce}')
    } finally { rmSync(vault, { recursive: true, force: true }) }
  })

  it('mindmap 风险只报告不自动修复（残余警告带行号与规则号）', async () => {
    const vault = makeVault(false)
    CFG.vaultDir = vault
    try {
      // mindmap 的 R9 风险没有修复器（R1-R8 才是 flowchart 零件）——清洗后残余转警告
      const r = await executeWikiWrite(CFG, {
        project: 'demo', path: 'mm.md',
        body: '```mermaid\nmindmap\n  root((x))\n    后端/服务\n```',
      })
      expect(r.status).toBe('ok')
      const data = r.data as Record<string, unknown>
      const warnings = data.warnings as string[]
      expect(warnings.some(w => w.includes('第 3 行') && w.includes('R9'))).toBe(true)
    } finally { rmSync(vault, { recursive: true, force: true }) }
  })

  it('git vault：提交成功并返回新 head', async () => {
    const vault = makeVault(true)
    CFG.vaultDir = vault
    try {
      const r = await executeWikiWrite(CFG, { project: 'demo', path: 'README.md', body: '# 总览', commit: true })
      expect(r.status).toBe('ok')
      const data = r.data as Record<string, unknown>
      expect(data.committed).toBe(true)
      expect(String(data.vaultHead)).toMatch(/^[0-9a-f]{7,}$/)
    } finally { rmSync(vault, { recursive: true, force: true }) }
  })

  it('commit=false 时跳过 git 提交（即便 vault 是 git 仓库）', async () => {
    const vault = makeVault(true)
    CFG.vaultDir = vault
    try {
      const r = await executeWikiWrite(CFG, { project: 'demo', path: 'README.md', body: '# 不提交', commit: false })
      const data = r.data as Record<string, unknown>
      expect(data.committed).toBe(false)
    } finally { rmSync(vault, { recursive: true, force: true }) }
  })
})

describe('executeWikiBuild（AI 构建业务）', () => {
  it('构建前预建快照（中断续传地基），agents 缺失时报中文错误', async () => {
    const vault = makeVault(false)
    const source = makeProject()
    CFG.vaultDir = vault
    try {
      const r = await executeWikiBuild(fakeCtx(undefined), CFG, { project: source, commit: true })
      expect(r.status).toBe('error')
      expect(r.message).toContain('代理注册表不可用')
      // 关键业务行为：即使子代理创建失败，快照也已落盘——wiki_status 能识别进度续传
      // 项目名取目录尾部（mkdtemp 随机后缀），直接从扫描结果取
      const name = scanProject(source).name
      expect(existsSync(join(join(vault, '项目知识库', name), '.wiki-meta.json'))).toBe(true)
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(source, { recursive: true, force: true })
    }
  })

  it('成功路径：子代理报告透传 + 返回项目名与知识库目录', async () => {
    const vault = makeVault(false)
    const source = makeProject()
    CFG.vaultDir = vault
    try {
      const agents = { create: async () => fakeHandle([
        { type: 'assistant/message', data: { content: [{ type: 'text', text: '构建完成：5 页' }] } },
      ]) }
      const r = await executeWikiBuild(fakeCtx(agents), CFG, { project: source, commit: false })
      expect(r.status).toBe('ok')
      const data = r.data as Record<string, unknown>
      expect(data.report).toBe('构建完成：5 页')
      expect(data.project).toBe(scanProject(source).name)
      expect(String(data.dir)).toContain('项目知识库')
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(source, { recursive: true, force: true })
    }
  })
})

describe('executeWikiEvolve（增量刷新业务）', () => {
  it('无变化时零开销返回 changed=false（不创建子代理）', async () => {
    const vault = makeVault(false)
    const source = makeProject()
    CFG.vaultDir = vault
    try {
      // 先建立同步快照
      const scan = scanProject(source)
      saveWikiMeta(vault, '项目知识库', scan.name, {
        project: scan.name, sourceRoot: source, gitHead: scan.gitHead,
        scannedAt: new Date().toISOString(), sourceDigest: '',
        files: Object.fromEntries(scan.files.map(f => [f.relPath, f.sha256])), pages: [],
      })
      let created = 0
      const agents = { create: async () => { created++; return fakeHandle([]) } }
      const r = await executeWikiEvolve(fakeCtx(agents), CFG, { project: source })
      expect(r.status).toBe('ok')
      const data = r.data as Record<string, unknown>
      expect(data.changed).toBe(false)
      expect(created).toBe(0) // 无变化绝不启动子代理
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(source, { recursive: true, force: true })
    }
  })

  it('有变化且刷新成功：快照同步到新状态', async () => {
    const vault = makeVault(false)
    const source = makeProject()
    CFG.vaultDir = vault
    try {
      const scan = scanProject(source)
      saveWikiMeta(vault, '项目知识库', scan.name, {
        project: scan.name, sourceRoot: source, gitHead: scan.gitHead,
        scannedAt: new Date().toISOString(), sourceDigest: '',
        files: Object.fromEntries(scan.files.map(f => [f.relPath, f.sha256])), pages: [],
      })
      const before = loadWikiMeta(vault, '项目知识库', scan.name)!
      // 修改一个文件触发判变
      writeFileSync(join(source, 'backend', 'src', 'App.java'), 'class App { int x; }')
      const agents = { create: async () => fakeHandle([
        { type: 'assistant/message', data: { content: [{ type: 'text', text: '已更新后端页' }] } },
      ]) }
      const r = await executeWikiEvolve(fakeCtx(agents), CFG, { project: source })
      expect(r.status).toBe('ok')
      const data = r.data as Record<string, unknown>
      expect(data.changed).toBe(true)
      expect(data.report).toBe('已更新后端页')
      expect((data.affectedModules as string[])).toContain('backend')
      // 成功后快照刷新：scannedAt 更新、files 包含新摘要
      const after = loadWikiMeta(vault, '项目知识库', scan.name)!
      expect(after.scannedAt).not.toBe(before.scannedAt)
      const newScan = scanProject(source)
      expect(after.files['backend/src/App.java']).toBe(newScan.files.find(f => f.relPath === 'backend/src/App.java')!.sha256)
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(source, { recursive: true, force: true })
    }
  })

  it('刷新失败时保留旧快照（避免误判同步）', async () => {
    const vault = makeVault(false)
    const source = makeProject()
    CFG.vaultDir = vault
    try {
      const scan = scanProject(source)
      saveWikiMeta(vault, '项目知识库', scan.name, {
        project: scan.name, sourceRoot: source, gitHead: scan.gitHead,
        scannedAt: '固定时间戳', sourceDigest: '',
        files: Object.fromEntries(scan.files.map(f => [f.relPath, f.sha256])), pages: [],
      })
      writeFileSync(join(source, 'frontend', 'src', 'main.ts'), 'export const x = 2')
      // agents 缺失 → runAiLeadBuild 报错 → evolve 失败
      const r = await executeWikiEvolve(fakeCtx(undefined), CFG, { project: source })
      expect(r.status).toBe('error')
      // 关键业务行为：失败不刷新快照——下次 wiki_status 仍判定不同步
      const after = loadWikiMeta(vault, '项目知识库', scan.name)!
      expect(after.scannedAt).toBe('固定时间戳')
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(source, { recursive: true, force: true })
    }
  })
})

describe('executeWikiStatus（同步状态业务）', () => {
  it('快照同步时 synced=true 且 reason 说明无变化', async () => {
    const vault = makeVault(false)
    const source = makeProject()
    CFG.vaultDir = vault
    try {
      const scan = scanProject(source)
      saveWikiMeta(vault, '项目知识库', scan.name, {
        project: scan.name, sourceRoot: source, gitHead: scan.gitHead,
        scannedAt: new Date().toISOString(), sourceDigest: '',
        files: Object.fromEntries(scan.files.map(f => [f.relPath, f.sha256])), pages: [],
      })
      const r = await executeWikiStatus(CFG, { project: source })
      expect(r.status).toBe('ok')
      const data = r.data as Record<string, unknown>
      expect(data.synced).toBe(true)
      expect(data.hasSnapshot).toBe(true)
      expect(data.reason).toContain('无变化')
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(source, { recursive: true, force: true })
    }
  })
})

describe('buildImpls（装配注册表）', () => {
  it('注册全部六个 wiki 工具且 execute 均为函数', () => {
    const impls = buildImpls(fakeCtx(undefined), { vaultDir: '/v', kbRoot: 'kb' })
    expect(impls.map(i => i.contractId).sort()).toEqual([
      'wiki_build', 'wiki_evolve', 'wiki_read', 'wiki_status', 'wiki_tree', 'wiki_write',
    ])
    for (const impl of impls) {
      expect(typeof impl.execute).toBe('function')
    }
  })

  it('六个装配闭包均可直接执行（覆盖率：闭包行）', async () => {
    const vault = makeVault(false)
    const source = makeProject()
    const impls = buildImpls(fakeCtx(undefined), { vaultDir: vault, kbRoot: '项目知识库' })
    try {
      // wiki_tree / wiki_read：纯 IO 成功路径
      const tree = await impls.find(i => i.contractId === 'wiki_tree')!.execute({ project: source })
      expect(tree.status).toBe('ok')
      const read = await impls.find(i => i.contractId === 'wiki_read')!.execute({ project: source, path: 'README.md' })
      expect(read.status).toBe('ok')
      // wiki_write：落盘成功（真实 tmp vault）
      const write = await impls.find(i => i.contractId === 'wiki_write')!.execute({ project: 'demo', path: 'a.md', body: '# 装配闭包', source })
      expect(write.status).toBe('ok')
      // wiki_status：无快照 → synced=false
      const status = await impls.find(i => i.contractId === 'wiki_status')!.execute({ project: source })
      expect(status.status).toBe('ok')
      // wiki_evolve：vault 尚无快照 → 首次生成判变 → agents 缺失报错（闭包已执行）
      const evolve = await impls.find(i => i.contractId === 'wiki_evolve')!.execute({ project: source })
      expect(evolve.status).toBe('error')
      expect(evolve.message).toContain('代理注册表不可用')
      // wiki_build：预建快照后子代理创建失败 → 中文错误（闭包已执行）
      const build = await impls.find(i => i.contractId === 'wiki_build')!.execute({ project: source })
      expect(build.status).toBe('error')
      expect(build.message).toContain('代理注册表不可用')
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(source, { recursive: true, force: true })
    }
  })
})

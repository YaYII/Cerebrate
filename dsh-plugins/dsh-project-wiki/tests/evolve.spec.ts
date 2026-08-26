import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanProject } from '../src/features/scanner'
import { diffAgainstSnapshot, saveWikiMeta, loadWikiMeta, evolveTaskText, sourceDigestOf, listWikiPages, digest } from '../src/features/evolve'
import { writePage } from '../src/features/writer'

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evolvespec-'))
  mkdirSync(join(dir, 'backend', 'src'), { recursive: true })
  mkdirSync(join(dir, 'frontend', 'src'), { recursive: true })
  writeFileSync(join(dir, 'backend', 'src', 'App.java'), 'class App {}')
  writeFileSync(join(dir, 'backend', 'src', 'Order.java'), 'class Order {}')
  writeFileSync(join(dir, 'frontend', 'src', 'main.ts'), 'export const x = 1')
  return dir
}

describe('evolve (change detection)', () => {
  it('detects no-change, modify, add, delete with module grouping', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'evolvevault-'))
    try {
      const s1 = scanProject(root)
      saveWikiMeta(vault, '项目知识库', s1.name, {
        project: s1.name, sourceRoot: root, gitHead: s1.gitHead,
        scannedAt: new Date().toISOString(), sourceDigest: sourceDigestOf(s1),
        files: Object.fromEntries(s1.files.map(f => [f.relPath, f.sha256])),
        pages: [],
      })
      // 无变化
      const d0 = diffAgainstSnapshot(s1, loadWikiMeta(vault, '项目知识库', s1.name))
      expect(d0.changed).toBe(false)
      // 变化
      writeFileSync(join(root, 'backend', 'src', 'Order.java'), 'class Order { int x; }')
      writeFileSync(join(root, 'backend', 'src', 'New.java'), 'class New {}')
      rmSync(join(root, 'frontend', 'src', 'main.ts'))
      const s2 = scanProject(root)
      const d = diffAgainstSnapshot(s2, loadWikiMeta(vault, '项目知识库', s2.name))
      expect(d.changed).toBe(true)
      expect(d.newOrModified).toContain('backend/src/Order.java')
      expect(d.newOrModified).toContain('backend/src/New.java')
      expect(d.deleted).toContain('frontend/src/main.ts')
      expect(d.affectedModules).toContain('backend')
      expect(d.affectedModules).toContain('frontend')
      // 任务文本携带变化
      const task = evolveTaskText(s2.name, d, vault, '项目知识库')
      expect(task).toContain('backend/src/Order.java')
      expect(task).toContain('受影响的模块')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('first scan without snapshot reports changed with all files', () => {
    const root = makeProject()
    try {
      const s = scanProject(root)
      const d = diffAgainstSnapshot(s, null)
      expect(d.changed).toBe(true)
      expect(d.reason).toContain('首次生成')
      expect(d.affectedModules).toEqual(expect.arrayContaining(['backend', 'frontend']))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('digest 是确定性 sha256（变异点：哈希计算）', () => {
    const a = digest('hello')
    const b = digest('hello')
    const c = digest('hello!')
    expect(a).toBe(b)
    expect(a.length).toBe(64)
    expect(c).not.toBe(a)
    // 已知值校验：sha256('hello') 应等于标准哈希（防算法漂移）
    const { createHash } = require('node:crypto')
    expect(a).toBe(createHash('sha256').update('hello').digest('hex'))
  })

  it('git head 变化触发 changed 并报告（变异点：headChanged 分支）', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'evolvevault-'))
    try {
      const s1 = scanProject(root)
      // 构造：gitHead 非空的扫描（模拟真实 git 仓库），快照 gitHead 不同
      const scanWithHead = { ...s1, gitHead: 'abc1234' }
      saveWikiMeta(vault, '项目知识库', s1.name, {
        project: s1.name, sourceRoot: root, gitHead: 'oldhead',
        scannedAt: new Date().toISOString(), sourceDigest: sourceDigestOf(s1),
        files: Object.fromEntries(s1.files.map(f => [f.relPath, f.sha256])),
        pages: [],
      })
      // 无文件变化，但 git head 不同
      const d = diffAgainstSnapshot(scanWithHead, loadWikiMeta(vault, '项目知识库', s1.name))
      expect(d.changed).toBe(true)
      expect(d.gitHeadChanged).toBe(true)
      expect(d.reason).toContain('git head 变化')
      expect(d.newOrModified).toEqual([])
      expect(d.deleted).toEqual([])
      // 相同 head → 无变化
      const d2 = diffAgainstSnapshot({ ...scanWithHead, gitHead: 'oldhead' }, loadWikiMeta(vault, '项目知识库', s1.name))
      expect(d2.changed).toBe(false)
      expect(d2.gitHeadChanged).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('删除整个模块的文件 → affectedModules 正确归组（变异点：indexOf/slice）', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'evolvevault-'))
    try {
      const s1 = scanProject(root)
      saveWikiMeta(vault, '项目知识库', s1.name, {
        project: s1.name, sourceRoot: root, gitHead: s1.gitHead,
        scannedAt: new Date().toISOString(), sourceDigest: sourceDigestOf(s1),
        files: Object.fromEntries(s1.files.map(f => [f.relPath, f.sha256])),
        pages: [],
      })
      // 删除 frontend 全部
      rmSync(join(root, 'frontend'), { recursive: true, force: true })
      const s2 = scanProject(root)
      const d = diffAgainstSnapshot(s2, loadWikiMeta(vault, '项目知识库', s2.name))
      expect(d.deleted.some(p => p.startsWith('frontend/'))).toBe(true)
      expect(d.affectedModules).toContain('frontend')
      expect(d.affectedModules).not.toContain('backend') // backend 未变
      // 根文件归组 '(root)'：构造无斜杠路径的差异
      const d2 = diffAgainstSnapshot({ ...s2, files: [{ ...s2.files[0]!, relPath: 'README.md' }] }, {
        project: s2.name, sourceRoot: root, gitHead: s2.gitHead,
        scannedAt: '', sourceDigest: '', files: { 'README.md': 'different' }, pages: [],
      })
      expect(d2.affectedModules).toContain('(root)')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('sourceDigestOf 确定性且随内容变化（变异点：拼接/哈希）', () => {
    const s1 = scanProject(makeProject())
    const s2 = scanProject(makeProject())
    const d1 = sourceDigestOf(s1)
    const d2 = sourceDigestOf(s2)
    // 相同结构 → 相同摘要（文件内容一致）
    expect(d1).toBe(d2)
    // 内容不同 → 摘要不同
    const root = s1.root
    writeFileSync(join(root, 'backend', 'src', 'App.java'), 'class App { int x; }')
    const s3 = scanProject(root)
    expect(sourceDigestOf(s3)).not.toBe(d1)
    // 摘要长度 64（sha256）
    expect(d1.length).toBe(64)
  })

  it('listWikiPages 过滤 .wiki-meta.json（变异点：=== 过滤）', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'evolvevault-'))
    try {
      const s = scanProject(root)
      saveWikiMeta(vault, '项目知识库', s.name, {
        project: s.name, sourceRoot: root, gitHead: s.gitHead,
        scannedAt: new Date().toISOString(), sourceDigest: sourceDigestOf(s),
        files: Object.fromEntries(s.files.map(f => [f.relPath, f.sha256])),
        pages: [],
      })
      const pages = listWikiPages(vault, '项目知识库', s.name)
      expect(pages).toEqual([]) // 无 md 页面
      // 写入一个页面后应列出
      writePage(vault, '项目知识库', s.name, 'README.md', '# 测试', 'abc')
      const pages2 = listWikiPages(vault, '项目知识库', s.name)
      expect(pages2).toEqual(['README.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('evolveTaskText 完整携带变化信息（变异点：join/切片）', () => {
    const d = {
      changed: true, reason: '2 个文件新增/修改', gitHeadChanged: false,
      newOrModified: ['a.ts', 'b.ts'], deleted: ['c.ts'],
      affectedModules: ['frontend', 'backend'],
    }
    const task = evolveTaskText('demo', d, '/vault', '项目知识库')
    expect(task).toContain('# 任务：增量刷新「demo」知识库')
    expect(task).toContain('变化原因：2 个文件新增/修改')
    expect(task).toContain('a.ts')
    expect(task).toContain('c.ts')
    expect(task).toContain('frontend、backend')
    expect(task).toContain('/vault/项目知识库/demo/')
    expect(task).toContain('增量刷新')
  })


describe('scanner 过滤逻辑（变异靶向）', () => {
  it('过滤二进制/产物/隐藏目录，统计语言与行数', () => {
    const root = mkdtempSync(join(tmpdir(), 'scanspec-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(root, '.hidden'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2\n\n')
    writeFileSync(join(root, 'node_modules', 'dep.ts'), 'export const x = 9')
    writeFileSync(join(root, '.hidden', 'secret.ts'), 'export const s = 1')
    writeFileSync(join(root, 'src', 'data.png'), 'PNG-BINARY')
    try {
      const s = scanProject(root)
      // node_modules 与隐藏目录被排除
      expect(s.files.some(f => f.relPath.includes('node_modules'))).toBe(false)
      expect(s.files.some(f => f.relPath.includes('.hidden'))).toBe(false)
      // 二进制 png 被排除
      expect(s.files.some(f => f.relPath.includes('png'))).toBe(false)
      // 语言计数与行数
      expect(s.languages['ts']).toBe(2)
      expect(s.totalLines).toBe(5) // a.ts 2 行（含结尾换行）+ b.ts 3 行（含两个换行）
      // excluded 计数（node_modules + .hidden + png）
      expect(Object.keys(s.excluded).length).toBeGreaterThanOrEqual(3)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('过滤超大文件（>256KB）与 NUL 字节二进制', () => {
    const root = mkdtempSync(join(tmpdir(), 'scanspec2-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    try {
      // 超大文件
      writeFileSync(join(root, 'src', 'big.txt'), 'x'.repeat(300 * 1024))
      // NUL 字节二进制（无扩展名识别）
      writeFileSync(join(root, 'src', 'blob.dat'), 'AB\u0000\u0000CD')
      const s = scanProject(root)
      expect(s.files.some(f => f.relPath.includes('big'))).toBe(false)
      expect(s.files.some(f => f.relPath.includes('blob'))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})



  it('256KB 阈值边界：恰在阈值内被保留、超阈值被过滤（变异点：常量 256）', () => {
    const root = mkdtempSync(join(tmpdir(), 'scanspec3-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    try {
      // 恰在阈值内（256KB - 1）→ 保留
      writeFileSync(join(root, 'src', 'edge_ok.ts'), 'x'.repeat(256 * 1024 - 1))
      // 恰超阈值（256KB + 1）→ 过滤
      writeFileSync(join(root, 'src', 'edge_big.ts'), 'y'.repeat(256 * 1024 + 1))
      const s = scanProject(root)
      expect(s.files.some(f => f.relPath === 'src/edge_ok.ts')).toBe(true)
      expect(s.files.some(f => f.relPath === 'src/edge_big.ts')).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('语言计数在重复扩展名时累加（变异点：计数 +）', () => {
    const root = mkdtempSync(join(tmpdir(), 'scanspec4-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    try {
      writeFileSync(join(root, 'src', 'x1.ts'), 'a')
      writeFileSync(join(root, 'src', 'x2.ts'), 'b')
      writeFileSync(join(root, 'src', 'x3.ts'), 'c')
      const s = scanProject(root)
      expect(s.languages['ts']).toBe(3)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })



  it('单文件语言计数从 1 起（变异点：?? 0 初始值）', () => {
    const root = mkdtempSync(join(tmpdir(), 'scanspec5-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    try {
      writeFileSync(join(root, 'src', 'only.ts'), 'a')
      const s = scanProject(root)
      expect(s.languages['ts']).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })



  it('排除目录计数精确累加（变异点：?? 0 初始值与 +1）', () => {
    const root = mkdtempSync(join(tmpdir(), 'scanspec6-'))
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'a'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'b'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'x.ts'), 'a')
    try {
      const s = scanProject(root)
      // node_modules 顶层排除计 1（子目录 a/b 因不在 SKIP_DIRS 会继续遍历，内部无文件不计入 excluded）
      expect(s.excluded['node_modules']).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })



  it('listWikiPages 三层嵌套路径（变异点：路径拼接 +）', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'evolvevault8-'))
    try {
      const s = scanProject(root)
      saveWikiMeta(vault, '项目知识库', s.name, {
        project: s.name, sourceRoot: root, gitHead: s.gitHead,
        scannedAt: new Date().toISOString(), sourceDigest: sourceDigestOf(s),
        files: Object.fromEntries(s.files.map(f => [f.relPath, f.sha256])), pages: [],
      })
      writePage(vault, '项目知识库', s.name, 'x/y/z/deep.md', '# 深', 'abc')
      const pages = listWikiPages(vault, '项目知识库', s.name)
      expect(pages).toContain('x/y/z/deep.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('首次生成断言 gitHeadChanged（变异点：布尔 true）', () => {
    const root = makeProject()
    try {
      const s = scanProject(root)
      const d = diffAgainstSnapshot(s, null)
      expect(d.gitHeadChanged).toBe(true)
      expect(d.newOrModified.length).toBe(s.files.length)
      expect(d.deleted).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

})

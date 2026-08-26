import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectTree, readFileBounded, safeVaultPath } from '../src/io'
import { writePage, stampFrontmatter, listPages, wikiDirFor } from '../src/writer'

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wikiio-'))
  mkdirSync(join(dir, 'backend', 'src'), { recursive: true })
  mkdirSync(join(dir, 'frontend', 'src'), { recursive: true })
  mkdirSync(join(dir, 'docker'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# demo\n\n前后端分离项目。\n')
  writeFileSync(join(dir, 'backend', 'pom.xml'), '<project><name>backend</name></project>')
  writeFileSync(join(dir, 'frontend', 'package.json'), '{"name":"frontend"}')
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}')
  writeFileSync(join(dir, 'backend', 'src', 'OrderService.java'), 'class OrderService {}')
  return dir
}

describe('io (AI browsing)', () => {
  it('wiki_tree lists real module boundaries', () => {
    const root = makeProject()
    try {
      const t = projectTree(root)
      const top = t.children?.map(c => c.path) ?? []
      expect(top).toContain('backend')
      expect(top).toContain('frontend')
      expect(top).toContain('docker')
      const backend = t.children?.find(c => c.path === 'backend')
      expect(backend?.children?.some(c => c.path === 'src')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('wiki_read returns bounded content', () => {
    const root = makeProject()
    try {
      const r = readFileBounded(root, 'README.md')
      expect(r.found).toBe(true)
      expect(r.content).toContain('前后端分离')
      const missing = readFileBounded(root, 'nope.md')
      expect(missing.found).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('safeVaultPath blocks traversal', () => {
    expect(safeVaultPath('02-后端/订单.md')).toBe('02-后端/订单.md')
    expect(safeVaultPath('../evil.md')).toBeNull()
    expect(safeVaultPath('a/../../evil.md')).toBeNull()
    expect(safeVaultPath('')).toBeNull()
  })
})

describe('writer (AI page sink)', () => {
  it('writePage stamps frontmatter and writes once', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'wikivault-'))
    try {
      const r1 = writePage(vault, '项目知识库', 'demo', '02-后端/README.md', '# 后端', 'abc123')
      expect(r1.written).toBe(true)
      const abs = join(wikiDirFor(vault, '项目知识库', 'demo'), '02-后端/README.md')
      const content = readFileSync(abs, 'utf8')
      expect(content).toContain('generator: dsh-project-wiki-ai')
      expect(content).toContain('git_head: abc123')
      expect(content).toContain('# 后端')
      // 幂等验证：同一正文第二次写入不应产生变化。
      const r2 = writePage(vault, '项目知识库', 'demo', '02-后端/README.md', '# 后端', 'abc123')
      expect(r2.written).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('stampFrontmatter preserves the AI title', () => {
    const fm = stampFrontmatter('# 系统架构\n正文', 'demo', 'h1')
    expect(fm).toContain('title: 系统架构')
    expect(fm).toContain('author: dsh-project-wiki (ai)')
    expect(fm).toContain('tags: [project-wiki, ai-led]')
  })

  it('writePage 更新内容时保留首代 created（变异点：preserveCreated）', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'wikivault3-'))
    try {
      const r1 = writePage(vault, '项目知识库', 'demo', 'README.md', '# 第一版', 'abc')
      const abs = join(wikiDirFor(vault, '项目知识库', 'demo'), 'README.md')
      const created1 = /^created: .+$/m.exec(readFileSync(abs, 'utf8'))![0]
      // 更新内容（changed=true），created 必须保留、updated 应变化
      const r2 = writePage(vault, '项目知识库', 'demo', 'README.md', '# 第二版', 'abc')
      expect(r2.written).toBe(true)
      expect(r2.changed).toBe(true)
      const content2 = readFileSync(abs, 'utf8')
      const created2 = /^created: .+$/m.exec(content2)![0]
      expect(created2).toBe(created1) // 首代 created 保留
      expect(content2).toContain('# 第二版')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('stampFrontmatter 标题取自首行或兜底项目名（变异点：|| 分支）', () => {
    // 首行非 # 开头 → 仍作为标题（实现约定：第一行即标题）
    const fm = stampFrontmatter('正文没有标题', 'myproj', 'h2')
    expect(fm).toContain('title: 正文没有标题')
    // git_head 缺省为 n/a
    const fm2 = stampFrontmatter('# 标题', 'p', '')
    expect(fm2).toContain('git_head: n/a')
    // 空正文 → 兜底项目名
    const fm3 = stampFrontmatter('', 'emptyproj', 'h3')
    expect(fm3).toContain('title: emptyproj 项目知识库')
  })

  it('writePage 幂等且 git_head 变化不触发重写（变异点：bodyOnly 比较）', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'wikivault4-'))
    try {
      writePage(vault, '项目知识库', 'demo', 'README.md', '# 内容', 'abc')
      // 相同正文、不同 git_head → 不重写（frontmatter 差异不算内容变化）
      const r2 = writePage(vault, '项目知识库', 'demo', 'README.md', '# 内容', 'xyz123')
      expect(r2.written).toBe(false)
      // 正文变化 → 重写
      const r3 = writePage(vault, '项目知识库', 'demo', 'README.md', '# 内容变了', 'xyz123')
      expect(r3.written).toBe(true)
      expect(r3.changed).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('writePage 覆盖无 created 的旧文件时不崩溃（变异点：!created 分支）', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'wikivault5-'))
    try {
      const dir = wikiDirFor(vault, '项目知识库', 'demo')
      mkdirSync(dir, { recursive: true })
      const abs = join(dir, 'old.md')
      // 旧文件无 frontmatter（无 created 行）
      writeFileSync(abs, '# 旧内容\n没有 frontmatter', 'utf8')
      const r = writePage(vault, '项目知识库', 'demo', 'old.md', '# 新内容', 'abc')
      expect(r.written).toBe(true)
      const content = readFileSync(abs, 'utf8')
      expect(content).toContain('# 新内容')
      expect(content).toContain('created:') // 新写入带 created
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('listPages walks nested md files', () => {
    const root = makeProject()
    const vault = mkdtempSync(join(tmpdir(), 'wikivault2-'))
    try {
      writePage(vault, '项目知识库', 'demo', 'README.md', '# 总览', '')
      writePage(vault, '项目知识库', 'demo', '02-后端/README.md', '# 后端', '')
      const pages = listPages(vault, '项目知识库', 'demo')
      expect(pages).toContain('README.md')
      expect(pages).toContain('02-后端/README.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(vault, { recursive: true, force: true })
    }
  })
})
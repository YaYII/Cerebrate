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
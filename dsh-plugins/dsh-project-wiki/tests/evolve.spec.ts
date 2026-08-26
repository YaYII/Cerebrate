import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanProject } from '../src/scanner'
import { diffAgainstSnapshot, saveWikiMeta, loadWikiMeta, evolveTaskText, sourceDigestOf, listWikiPages } from '../src/evolve'

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
})

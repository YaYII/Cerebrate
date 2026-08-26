/**
 * 知识库页面写入器：AI 之手伸进 vault 的通道。
 *
 * AI 撰写页面 Markdown（标题、Mermaid 图、证据引用）；本模块只负责记录：
 * frontmatter 戳记、幂等写入、孤儿清理、vault git 提交。无模板、无内容生成。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import os from 'node:os'

/** 展开路径中的 ~ 为用户主目录。 */
function expandHome(p: string): string {
  return p.replace(/^~/, os.homedir())
}

/** 在指定目录执行 git，返回去除首尾空白的输出；失败返回空串。 */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

/** 项目知识库在 vault 内的目录。 */
export function wikiDirFor(vaultDir: string, kbRoot: string, project: string): string {
  return join(expandHome(vaultDir), kbRoot, project)
}

/** 秒级精度 ISO 时间戳（frontmatter 用）。 */
function now(): string {
  return new Date().toISOString().replace(/\.\..+$/, '')
}

/** 转义 frontmatter 值（冒号、换行）。 */
function esc(value: string): string {
  return value.replace(/[\n:]/g, ' ').trim()
}

/**
 * 给 AI 撰写的页面打 frontmatter 戳记。AI 写正文，此处补团队 vault 的
 * 元数据契约（author/generator/updated/tags）。
 */
export function stampFrontmatter(body: string, project: string, gitHead: string): string {
  const updated = now()
  const content = body.trim()
  const title = (content.split('\n')[0] ?? '').replace(/^#\s*/, '').trim() || project + ' 项目知识库'
  return [
    '---',
    'title: ' + esc(title),
    'created: ' + updated,
    'updated: ' + updated,
    'author: dsh-project-wiki (ai)',
    'generator: dsh-project-wiki-ai',
    'project: ' + esc(project),
    'git_head: ' + (gitHead || 'n/a'),
    'tags: [project-wiki, ai-led]',
    '---',
    '',
    content,
  ].join('\n')
}

/** 更新时保留首代 created 行。 */
function preserveCreated(prev: string | null, next: string): string {
  if (prev === null) return next
  const created = /^created: .+$/m.exec(prev)
  if (!created) return next
  return next.replace(/^created: .+$/m, created[0]!)
}

/**
 * 把一页（或全部页）写入 vault 知识库目录，返回逐页结果供 AI 观察变化。
 * 幂等：内容未变时跳过。
 */
export function writePage(
  vaultDir: string,
  kbRoot: string,
  project: string,
  relPath: string,
  body: string,
  gitHead: string,
): { path: string; written: boolean; changed: boolean } {
  const dir = wikiDirFor(vaultDir, kbRoot, project)
  const abs = join(dir, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  const prev = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  const content = stampFrontmatter(body, project, gitHead)
  const withCreated = preserveCreated(prev, content)
  // 幂等判定：stampFrontmatter 内嵌了新的 updated 时间戳，因此只比较
  // 正文（frontmatter 之外的部分）——内容未变即视为未变更。
  const bodyOnly = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n/, '')
  if (prev !== null && bodyOnly(prev) === bodyOnly(withCreated)) return { path: relPath, written: false, changed: false }
  writeFileSync(abs, withCreated, 'utf8')
  return { path: relPath, written: true, changed: prev !== null }
}

/**
 * 提交 vault 工作树（干净或非仓库时为空操作）。消息携带 ISO 时间戳，
 * 遵循 obsidian-knowledge-git 契约。
 */
export function vaultCommit(vaultRoot: string, message: string): { committed: boolean; head: string } {
  const root = expandHome(vaultRoot)
  if (!existsSync(join(root, '.git'))) return { committed: false, head: '' }
  spawnSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
  const status = git(root, ['status', '--porcelain'])
  if (status.length === 0) return { committed: false, head: git(root, ['rev-parse', '--short', 'HEAD']) }
  const res = spawnSync('git', ['commit', '-m', message, '--no-verify'], { cwd: root, stdio: 'ignore' })
  if (res.status !== 0) return { committed: false, head: git(root, ['rev-parse', '--short', 'HEAD']) }
  return { committed: true, head: git(root, ['rev-parse', '--short', 'HEAD']) }
}

/** 字符串的 sha256 摘要（进化固定页面对比用）。 */
export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 列出知识库目录下全部页面（供清理与状态使用）。 */
export function listPages(vaultDir: string, kbRoot: string, project: string): string[] {
  const dir = wikiDirFor(vaultDir, kbRoot, project)
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      if (n === '.wiki-meta.json') continue
      const abs = join(d, n)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) walk(abs, rel ? rel + '/' + n : n)
      else if (n.endsWith('.md')) out.push(rel ? rel + '/' + n : n)
    }
  }
  walk(dir, '')
  return out.sort()
}

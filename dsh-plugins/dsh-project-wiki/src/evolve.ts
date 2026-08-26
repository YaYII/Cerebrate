/**
 * AI 主导的知识库进化：检测项目代码变化并刷新知识库。
 *
 * 快照（vault 知识库目录下的 .wiki-meta.json）记录项目的 git head 与逐文件
 * sha256 摘要。evolve 把当前扫描与快照对比，报告「什么变了」（新增/修改/删除
 * 的文件，按模块分组），并把变化清单交给 AI——让它只撰写/更新受影响的页面，
 * 而不是全量重建。
 *
 * 自动触发：插件可注册定时器（ctx.setInterval）轮询配置的项目根目录，代码
 * 变化时自动调用 evolve。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import type { ProjectScan } from './scanner'

/** 一个已生成知识库的快照。 */
export interface WikiMeta {
  project: string
  sourceRoot: string
  gitHead: string
  scannedAt: string
  /** 全部扫描源文件的聚合 sha256（排序的 relPath:sha）。 */
  sourceDigest: string
  /** 逐文件摘要（relPath → sha256），用于精确变更检测。 */
  files: Record<string, string>
  /** 知识库已知页面（供清理提示）。 */
  pages: string[]
}

/** 一次变更对比的结果。 */
export interface ChangeDiff {
  changed: boolean
  reason: string
  gitHeadChanged: boolean
  /** 新增或修改的文件（相对路径）。 */
  newOrModified: string[]
  /** 删除的文件（相对路径）。 */
  deleted: string[]
  /** 受影响的模块（顶层目录）——AI 的刷新范围。 */
  affectedModules: string[]
}

/** 展开路径中的 ~ 为用户主目录。 */
function expandHome(p: string): string {
  return p.replace(/^~/, os.homedir())
}

/** 字符串的 sha256 摘要。 */
export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 项目的 git 短提交号（非 git 仓库返回空串）。 */
export function projectGitHead(projectRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

/** 扫描源文件的聚合摘要。 */
export function sourceDigestOf(scan: ProjectScan): string {
  const parts = scan.files.map(f => f.relPath + ':' + f.sha256).sort().join('\n')
  return createHash('sha256').update(parts).digest('hex')
}

/** 从扫描结果构造逐文件摘要表。 */
export function fileDigests(scan: ProjectScan): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of scan.files) out[f.relPath] = f.sha256
  return out
}

/** 项目知识库在 vault 内的目录。 */
export function wikiDirFor(vaultDir: string, kbRoot: string, project: string): string {
  return join(expandHome(vaultDir), kbRoot, project)
}

/** 加载快照（不存在或损坏时返回 null）。 */
export function loadWikiMeta(vaultDir: string, kbRoot: string, project: string): WikiMeta | null {
  const p = join(wikiDirFor(vaultDir, kbRoot, project), '.wiki-meta.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WikiMeta
  } catch {
    return null
  }
}

/** 持久化快照。 */
export function saveWikiMeta(vaultDir: string, kbRoot: string, project: string, meta: WikiMeta): void {
  const dir = wikiDirFor(vaultDir, kbRoot, project)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.wiki-meta.json'), JSON.stringify(meta, null, 2), 'utf8')
}

/** 列出知识库目录下的 markdown 页面。 */
export function listWikiPages(vaultDir: string, kbRoot: string, project: string): string[] {
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

/**
 * 把当前扫描与快照对比，返回精确的变更差异——AI 据此只刷新受影响页面。
 */
export function diffAgainstSnapshot(scan: ProjectScan, meta: WikiMeta | null): ChangeDiff {
  const head = scan.gitHead
  if (!meta) {
    return {
      changed: true,
      reason: '首次生成（无快照）',
      gitHeadChanged: true,
      newOrModified: scan.files.map(f => f.relPath),
      deleted: [],
      affectedModules: affectedModulesOf(scan.files.map(f => f.relPath)),
    }
  }
  const headChanged = head !== '' && meta.gitHead !== head
  const curFiles = fileDigests(scan)
  const newOrModified: string[] = []
  const deleted: string[] = []
  for (const [rel, sha] of Object.entries(curFiles)) {
    if (meta.files[rel] !== sha) newOrModified.push(rel)
  }
  for (const rel of Object.keys(meta.files)) {
    if (!(rel in curFiles)) deleted.push(rel)
  }
  const changed = headChanged || newOrModified.length > 0 || deleted.length > 0
  const reason = changed
    ? [
        headChanged ? 'git head 变化：' + meta.gitHead + ' → ' + head : '',
        newOrModified.length > 0 ? newOrModified.length + ' 个文件新增/修改' : '',
        deleted.length > 0 ? deleted.length + ' 个文件删除' : '',
      ].filter(Boolean).join('；')
    : '自上次生成以来代码无变化'
  return {
    changed,
    reason,
    gitHeadChanged: headChanged,
    newOrModified,
    deleted,
    affectedModules: affectedModulesOf([...newOrModified, ...deleted]),
  }
}

/** 每个文件的顶层模块（首个路径段）；根文件归入 '(root)'。 */
function affectedModulesOf(files: string[]): string[] {
  const set = new Set<string>()
  for (const f of files) {
    const i = f.indexOf('/')
    set.add(i === -1 ? '(root)' : f.slice(0, i))
  }
  return [...set].sort()
}

/**
 * 构建增量刷新的 AI 任务文本：把差异交给它，让它决定改哪些页面。
 */
export function evolveTaskText(projectName: string, diff: ChangeDiff, vaultDir: string, kbRoot: string): string {
  return [
    '# 任务：增量刷新「' + projectName + '」知识库（代码已变化）',
    '',
    '变化原因：' + diff.reason,
    '受影响的模块：' + (diff.affectedModules.join('、') || '无'),
    '',
    '## 步骤',
    '1. 用 wiki_tree/wiki_read 查看变化文件（重点：' + diff.newOrModified.slice(0, 20).join('、') + '）',
    '2. 判断哪些知识库页面需要更新（对应模块的 README/架构/业务页），用 wiki_write 更新它们',
    '3. 若删除的文件曾影响页面（如某模块整体移除），同步调整对应页面',
    '4. 只更新受影响的页面，不要重建整个知识库；未变化的模块保持原样',
    '5. 完成后总结：更新了哪些页面、依据哪些变化文件',
    '',
    '知识库根目录：' + vaultDir + '/' + kbRoot + '/' + projectName + '/',
    '',
    '> Mermaid 安全写法与证据引用规则同 wiki_build。',
  ].join('\n')
}

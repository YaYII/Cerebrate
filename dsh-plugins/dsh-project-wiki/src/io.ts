/**
 * 纯 IO 浏览工具（目录树 + 读文件），供 AI 主导的知识库构建使用。
 *
 * 这些工具刻意不做任何解析：它们把项目真实的目录树与文件内容交给 AI，
 * 由 AI 判断架构是什么（前端/后端/容器/数据库……）、该读什么、知识库怎么
 * 组织。代码分析、结构识别与页面撰写属于 AI——而不是插件。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 目录树视图始终跳过的目录（构建产物、版本库垃圾）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', 'target', '.idea', '.vscode', '.venv', 'venv', '__pycache__', 'vendor',
  'lib', '.turbo', 'tmp', 'bin', '.old', '.stale', 'reports', 'demo', '.code-review', '.dsh',
])

/** 目录树中的一个条目。 */
export interface TreeEntry {
  /** 相对项目根的路径（'' = 根节点）。 */
  path: string
  /** 条目类型：目录或文件。 */
  type: 'dir' | 'file'
  /** 直接子节点（仅目录）。 */
  children?: TreeEntry[]
  /** 文件大小（字节，仅文件）。 */
  bytes?: number
}

/** 目录树最大深度与文件数上限（防止超大仓库把上下文打爆）。 */
const MAX_TREE_DEPTH = 4
const MAX_TREE_FILES = 400

/**
 * 构建项目的目录树（有界）。AI 读它来识别真实模块边界——backend/、
 * frontend/、docker/、database/ 等——并规划知识库结构。
 */
export function projectTree(root: string, depth = 0): TreeEntry {
  const stat = statSync(root)
  if (!stat.isDirectory()) {
    return { path: '', type: 'file', bytes: stat.size }
  }
  const entries = readdirSync(root).sort()
  const children: TreeEntry[] = []
  let count = 0
  for (const name of entries) {
    if (count >= MAX_TREE_FILES) break
    const abs = join(root, name)
    let st: ReturnType<typeof statSync>
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.github')) continue
      count++
      children.push({
        path: name,
        type: 'dir',
        ...(depth < MAX_TREE_DEPTH ? { children: projectTree(abs, depth + 1).children ?? [] } : {}),
      })
    } else {
      count++
      children.push({ path: name, type: 'file', bytes: st.size })
    }
  }
  return { path: '', type: 'dir', children }
}

/**
 * 读取一个文件的文本内容（有界）。AI 用它理解架构并撰写页面；
 * 不做解析、不做推断。
 */
export function readFileBounded(root: string, relPath: string, maxBytes = 96 * 1024, headChars = 40000): { found: boolean; content: string; truncated: boolean } {
  const abs = join(root, relPath)
  try {
    const st = statSync(abs)
    if (!st.isFile()) return { found: false, content: '', truncated: false }
    const raw = readFileSync(abs, 'utf8')
    const truncated = raw.length > maxBytes
    const slice = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw
    const content = slice.length > headChars ? slice.slice(0, headChars) + '\n…（已截断，共 ' + raw.length + ' 字符）' : slice
    return { found: true, content, truncated }
  } catch {
    return { found: false, content: '', truncated: false }
  }
}

/** 只列顶层条目——最快的模块边界快照。 */
export function topLevelEntries(root: string): TreeEntry[] {
  return projectTree(root, 0).children ?? []
}

/** 清洗 vault 相对路径：禁止穿越、禁止绝对路径、仅限 .md。 */
export function safeVaultPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  if (p.includes('..')) return null
  if (p.length === 0 || p.length > 300) return null
  return p
}

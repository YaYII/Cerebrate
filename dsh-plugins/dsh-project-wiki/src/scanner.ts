/**
 * 最小项目扫描器——仅做文件清单与 sha256 摘要。
 *
 * 供进化引擎做确定性变更检测。它不做任何解析与语义提取：内容理解属于 AI
 * （wiki_read/wiki_tree）。这是变更检测的地基，不是内容生成器。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

/** 遍历时跳过的目录（构建产物、版本库垃圾）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', 'target', '.idea', '.vscode', '.venv', 'venv', '__pycache__', 'vendor',
  'lib', '.turbo', 'tmp', 'bin', '.old', '.stale', 'reports', 'demo', '.code-review', '.dsh',
])

/** 整文件跳过的清单（锁文件、构建信息）。 */
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.tsbuildinfo', '.wiki-meta.json'])

/** 跳过的二进制扩展名（AI 无法读取，且会污染 digest）。 */
const SKIP_EXTS = new Set(['.jar', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.tar', '.gz', '.lock', '.pem', '.key', '.crt', '.class', '.exe', '.bin', '.db', '.sqlite'])

/** 扫描到的一个源文件。 */
export interface SourceFile {
  /** 相对项目根的路径（正斜杠）。 */
  relPath: string
  /** 按扩展名识别的语言。 */
  language: string
  /** 物理代码行数。 */
  lines: number
  /** 源文本的 sha256（驱动确定性进化）。 */
  sha256: string
  /** 导入语句（最小扫描不填充，保留形状）。 */
  imports: string[]
  /** 导出符号（最小扫描不填充）。 */
  exports: string[]
  /** 顶层声明（最小扫描不填充）。 */
  declarations: Array<{ kind: string; name: string; line: number }>
}

/** 整项目扫描结果（最小版）。 */
export interface ProjectScan {
  root: string
  name: string
  gitHead: string
  languages: Record<string, number>
  entries: string[]
  files: SourceFile[]
  totalFiles: number
  totalLines: number
  excluded: Record<string, number>
  scannedAt: string
}

/** 文本的 sha256 摘要。 */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** NUL 字节嗅探：前 8KB 出现即视为二进制。 */
function isTextFile(text: string): boolean {
  return !text.includes('\u0000')
}

/**
 * 遍历项目收集带摘要的源文件。确定性、有界（单文件 256KB 上限）、零解析。
 */
export function scanProject(root: string): ProjectScan {
  const collector = collectSources(root)
  collector.files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return {
    root,
    name: root.split('/').filter(Boolean).pop() ?? 'project',
    gitHead: projectHead(root),
    languages: collector.languages,
    entries: [],
    files: collector.files,
    totalFiles: collector.files.length,
    totalLines: collector.totalLines,
    excluded: collector.excluded,
    scannedAt: new Date().toISOString(),
  }
}

/** 收集过程中的统计容器。 */
interface SourceCollector {
  files: SourceFile[]
  languages: Record<string, number>
  totalLines: number
  excluded: Record<string, number>
}

/** 递归遍历目录收集源文件（含二进制/产物过滤）。 */
function collectSources(root: string): SourceCollector {
  const collector: SourceCollector = { files: [], languages: {}, totalLines: 0, excluded: {} }
  const walk = (dir: string, rel: string) => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const abs = join(dir, name)
      const relPath = rel ? rel + '/' + name : name
      let st: ReturnType<typeof statSync>
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) { collector.excluded[name] = (collector.excluded[name] ?? 0) + 1; continue }
        walk(abs, relPath)
      } else {
        collectFile(collector, abs, relPath, name)
      }
    }
  }
  walk(root, '')
  return collector
}

/** 收集单个文件：过滤产物与二进制，统计语言与行数，写入 collector。 */
function collectFile(collector: SourceCollector, abs: string, relPath: string, name: string): void {
  let st: ReturnType<typeof statSync>
  try { st = statSync(abs) } catch { return }
  if (SKIP_FILES.has(name) || st.size > 256 * 1024) { collector.excluded[name] = (collector.excluded[name] ?? 0) + 1; return }
  let text = ''
  try { text = readFileSync(abs, 'utf8') } catch { return }
  // 二进制嗅探（NUL 字节）或已知二进制扩展名 → 跳过（不参与 digest，AI 也读不了）
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  if (SKIP_EXTS.has(ext) || !isTextFile(text)) { collector.excluded[ext || name] = (collector.excluded[ext || name] ?? 0) + 1; return }
  const lang = ext ? ext.slice(1) : 'txt'
  collector.languages[lang] = (collector.languages[lang] ?? 0) + 1
  const lines = text.split('\n').length
  collector.totalLines += lines
  collector.files.push({
    relPath,
    language: lang,
    lines,
    sha256: sha256(text),
    imports: [],
    exports: [],
    declarations: [],
  })
}

/** 项目的 git 短提交号（非 git 仓库返回空串）。 */
function projectHead(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

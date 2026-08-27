/**
 * 架构指纹与漂移检测 —— AI 代码防漂移的核心锚点。
 *
 * 架构指纹：对项目生成稳定的结构快照（文件清单+sha256、功能层/业务层边界、
 * 依赖方向、导出符号计数），保存为基线。代码变更后重算指纹并与基线对比，
 * 精确报告「哪里漂移了」——新增/删除/修改文件、分层边界变化、依赖方向倒转。
 *
 * 愿景：AI 每次生成代码后，用指纹把代码「拉回」架构锚点，防止结构漂移。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** 遍历时跳过的目录。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', 'target', '.idea', '.vscode', '.venv', 'venv', '__pycache__', 'vendor',
  'lib', '.turbo', 'tmp', 'bin', '.old', '.stale', 'reports', 'demo', '.code-review',
  '.code-arch', 'scripts', 'tests',
])

/** 功能层目录标记（原子砖块）。 */
const FEATURE_DIRS = ['utils', 'util', 'tools', 'lib', 'core', 'shared', 'helpers', 'helper', 'features', 'feature', 'infra', 'infrastructure']
/** 业务层目录标记（编排组合）。 */
const BUSINESS_DIRS = ['biz', 'business', 'services', 'service', 'controllers', 'controller', 'app', 'modules', 'module', 'domains', 'domain', 'handlers', 'handler']

/** 一层架构指纹。 */
export interface ArchFingerprint {
  /** 生成时间。 */
  createdAt: string
  /** 文件指纹：相对路径 → sha256。 */
  files: Record<string, string>
  /** 功能层文件清单（原子砖块）。 */
  featureFiles: string[]
  /** 业务层文件清单（编排组合）。 */
  businessFiles: string[]
  /** 依赖方向违规清单（功能层 import 业务层）。 */
  dependencyViolations: Array<{ file: string; line: number; target: string }>
  /** 各层导出符号计数（漂移监测）。 */
  exportCounts: { feature: number; business: number }
}

/** 指纹对比结果（漂移报告）。 */
export interface FingerprintDiff {
  /** 是否发生漂移。 */
  drifted: boolean
  /** 新增文件。 */
  added: string[]
  /** 修改文件（内容变化）。 */
  modified: string[]
  /** 删除文件。 */
  deleted: string[]
  /** 分层边界变化（文件在功能层/业务层之间迁移）。 */
  layerMoved: string[]
  /** 依赖方向违规变化（新增/消除）。 */
  dependencyChanged: string[]
}

/** sha256 摘要。 */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 收集项目内全部源码文件（跳过产物目录）。 */
function collectFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
      const abs = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) walk(abs)
      else if (/\.(ts|tsx|js|jsx|py|java|kt|go|rs|php)$/.test(name)) out.push(abs)
    }
  }
  walk(root)
  return out.sort()
}

/** 判断相对路径所属层级。 */
function layerOf(rel: string): 'feature' | 'business' | 'other' {
  const segs = rel.split('/')
  if (segs.some(s => FEATURE_DIRS.includes(s))) return 'feature'
  if (segs.some(s => BUSINESS_DIRS.includes(s))) return 'business'
  return 'other'
}

/** 提取文件的相对导入目标。 */
function importsOf(text: string): Array<{ target: string; line: number }> {
  const out: Array<{ target: string; line: number }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /from\s+['"]([^'"]+)['"]/.exec(lines[i]!)
    if (m && m[1]!.startsWith('.')) out.push({ target: m[1]!, line: i + 1 })
  }
  return out
}

/** 生成项目架构指纹。 */
export function fingerprintProject(root: string): ArchFingerprint {
  const files = collectFiles(root)
  const fp: ArchFingerprint = {
    createdAt: new Date().toISOString(),
    files: {},
    featureFiles: [],
    businessFiles: [],
    dependencyViolations: [],
    exportCounts: { feature: 0, business: 0 },
  }
  for (const abs of files) {
    const rel = abs.slice(root.length + 1).replace(/\\/g, '/')
    const text = readFileSync(abs, 'utf8')
    fp.files[rel] = sha256(text)
    const layer = layerOf(rel)
    if (layer === 'feature') fp.featureFiles.push(rel)
    if (layer === 'business') fp.businessFiles.push(rel)
    // 导出符号计数
    const exports = (text.match(/export\s+(?:async\s+)?function|export\s+const|export\s+class|export\s+interface|export\s+type/g) || []).length
    if (layer === 'feature') fp.exportCounts.feature += exports
    if (layer === 'business') fp.exportCounts.business += exports
    // 依赖方向检查：功能层 import 业务层
    if (layer === 'feature') {
      for (const imp of importsOf(text)) {
        const targetSegs = imp.target.split('/')
        if (targetSegs.some(s => BUSINESS_DIRS.includes(s))) {
          fp.dependencyViolations.push({ file: rel, line: imp.line, target: imp.target })
        }
      }
    }
  }
  return fp
}

/** 对比两个指纹，返回漂移报告。 */
export function diffFingerprints(baseline: ArchFingerprint, current: ArchFingerprint): FingerprintDiff {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  for (const [rel, sha] of Object.entries(current.files)) {
    if (!(rel in baseline.files)) added.push(rel)
    else if (baseline.files[rel] !== sha) modified.push(rel)
  }
  for (const rel of Object.keys(baseline.files)) {
    if (!(rel in current.files)) deleted.push(rel)
  }
  // 分层迁移：同一文件从 feature 变 business（或反之）
  const layerMoved: string[] = []
  for (const rel of Object.keys(current.files)) {
    const bl = baseline.featureFiles.includes(rel) ? 'feature' : baseline.businessFiles.includes(rel) ? 'business' : null
    const cl = current.featureFiles.includes(rel) ? 'feature' : current.businessFiles.includes(rel) ? 'business' : null
    if (bl && cl && bl !== cl) layerMoved.push(rel)
  }
  // 依赖方向违规变化
  const depKeys = (v: ArchFingerprint) => v.dependencyViolations.map(d => d.file + ':' + d.line).sort()
  const baseDeps = new Set(depKeys(baseline))
  const curDeps = new Set(depKeys(current))
  const dependencyChanged = [...curDeps].filter(d => !baseDeps.has(d))
    .concat([...baseDeps].filter(d => !curDeps.has(d)))
  return {
    drifted: added.length > 0 || modified.length > 0 || deleted.length > 0 || layerMoved.length > 0 || dependencyChanged.length > 0,
    added,
    modified,
    deleted,
    layerMoved,
    dependencyChanged,
  }
}

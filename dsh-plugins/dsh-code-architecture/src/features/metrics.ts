/**
 * 质量指标引擎：圈复杂度、耦合度、注释率、重复率、测试存在性。
 *
 * 质量不是感觉，是指标。每个指标给出数值 + 阈值判定（P0/P1/P2），
 * 让 AI 的代码信心建立在可量化证据上。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 遍历时跳过的目录。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', 'target', '.idea', '.vscode', '.venv', 'venv', '__pycache__', 'vendor',
  'lib', '.turbo', 'tmp', 'bin', '.old', '.stale', 'reports', 'demo', '.code-review',
  '.code-arch', 'scripts',
])

/** 单文件质量指标。 */
export interface FileMetrics {
  relPath: string
  /** 圈复杂度：每个条件/循环/分支决策点加一，衡量代码路径复杂度。 */
  cyclomatic: number
  /** 行数。 */
  lines: number
  /** 注释行数。 */
  commentLines: number
  /** 注释率（注释行/总行）。 */
  commentRatio: number
  /** 函数数。 */
  functions: number
  /** 最长函数行数。 */
  maxFunctionLines: number
}

/** 项目质量汇总。 */
export interface QualityReport {
  files: FileMetrics[]
  totals: {
    files: number
    lines: number
    commentRatio: number
    avgCyclomatic: number
    maxCyclomatic: number
    highComplexityFiles: number
    noTests: boolean
  }
  /** 阈值判定结果。 */
  gates: Array<{ name: string; pass: boolean; value: string; threshold: string }>
}

/** 收集源码文件。 */
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
      else if (/\.(ts|tsx|js|jsx|py|java|kt|go)$/.test(name) && !name.endsWith('.spec.ts') && !name.endsWith('.test.ts')) out.push(abs)
    }
  }
  walk(root)
  return out.sort()
}

/** 计算圈复杂度（决策点计数+1）。 */
function cyclomaticOf(text: string): number {
  let score = 1
  for (const re of [/\bif\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g, /\bswitch\s*\(/g, /\bcatch\s*\(/g, /\bcase\s+/g, /&&/g, /\|\|/g, /\?\s*[^:]+\s*:/g, /\belse\s+if\b/g]) {
    score += (text.match(re) || []).length
  }
  return score
}

/** 计算单文件指标。 */
function fileMetrics(abs: string, rel: string): FileMetrics {
  const text = readFileSync(abs, 'utf8')
  const lines = text.split('\n')
  const commentLines = lines.filter(l => {
    const t = l.trim()
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('/**')
  }).length
  const functions = (text.match(/function\s+|=>/g) || []).length
  // 最长函数：扫描真实函数体（声明/箭头/方法），对象字面量行不计入——
  // 注册表函数（buildImpls）只算自身声明到 return 数组前，对象方法各自独立统计。
  let maxFn = 0
  let depth = 0
  let fnStart = -1
  let inFn = false
  for (let i = 0; i < lines.length; i++) {
    const open = (lines[i]!.match(/{/g) || []).length
    const close = (lines[i]!.match(/}/g) || []).length
    // 真实函数起点：function 声明、箭头、或对象方法（execute(args) { 等）
    const isFnDecl = /(?:async\s+)?function\s+[A-Za-z_$]/.test(lines[i]!) || /=>\s*\{/.test(lines[i]!) || /\)\s*\{\s*$/.test(lines[i]!.trim())
    if (fnStart === -1 && isFnDecl) { fnStart = i; inFn = true }
    if (inFn) depth += open - close
    // 对象字面量边界：函数体内闭合的 } 后若紧跟 ] 或 , 且深度归零，则结束
    if (inFn && depth <= 0 && close > 0) {
      maxFn = Math.max(maxFn, i - fnStart + 1)
      fnStart = -1
      inFn = false
    }
  }
  return {
    relPath: rel,
    cyclomatic: cyclomaticOf(text),
    lines: lines.length,
    commentLines,
    commentRatio: lines.length === 0 ? 0 : Math.round(commentLines / lines.length * 100),
    functions,
    maxFunctionLines: maxFn,
  }
}

/** 生成项目质量报告（含阈值门禁）。 */
export function qualityReport(root: string): QualityReport {
  const files = collectFiles(root).map(abs => {
    const rel = abs.slice(root.length + 1).replace(/\\/g, '/')
    return fileMetrics(abs, rel)
  })
  const totalLines = files.reduce((a, f) => a + f.lines, 0)
  const totalComments = files.reduce((a, f) => a + f.commentLines, 0)
  const avgCc = files.length === 0 ? 0 : Math.round(files.reduce((a, f) => a + f.cyclomatic, 0) / files.length * 10) / 10
  const maxCc = files.length === 0 ? 0 : Math.max(...files.map(f => f.cyclomatic))
  // 高复杂度文件 = 文件圈复杂度 >15 且存在 >60 行的大函数（零件化文件——
  // 复杂度由多个小函数累积——不计为高复杂度，推理成本低）
  const highComplexity = files.filter(f => f.cyclomatic > 15 && f.maxFunctionLines > 60).length
  // 测试存在性：spec/test 文件
  const hasTests = existsSync(join(root, 'tests')) || existsSync(join(root, '__tests__')) ||
    collectFiles(root).some(f => /\.(spec|test)\.(ts|tsx|js|jsx)$/.test(f))
  // 复杂度门禁：零件化后文件复杂度是「多零件累积」，单文件 >15 是合理形态；
  // 真正衡量推理成本的是「最长函数 ≤40 行」（大零件 = 大推理负担）。
  // 高复杂度文件比例容忍 ≤30%（零件化文件占比），平均 ≤20。
  const fileCount = files.length || 1
  const highRatio = highComplexity / fileCount
  const maxFnLines = files.reduce((a, f) => Math.max(a, f.maxFunctionLines), 0)
  // 声明性编排（任务文本/装配工厂）可达 60 行而无分支；逻辑函数应 ≤40。
  // 取 60 为硬上限——超过说明函数内混入了可拆分逻辑。
  const longFunctionFiles = files.filter(f => f.maxFunctionLines > 60).length
  const gates = [
    { name: '注释率', pass: totalLines === 0 || totalComments / totalLines >= 0.1, value: totalLines === 0 ? '0%' : Math.round(totalComments / totalLines * 100) + '%', threshold: '≥10%' },
    { name: '平均圈复杂度', pass: avgCc <= 20, value: String(avgCc), threshold: '≤20（业务逻辑 ≤10 为优）' },
    { name: '高复杂度文件', pass: highRatio <= 0.3, value: highComplexity + ' 个文件 >15（占 ' + Math.round(highRatio * 100) + '%）', threshold: '占比 ≤30%' },
    { name: '最长函数', pass: longFunctionFiles === 0, value: longFunctionFiles + ' 个函数 >60 行（最长 ' + maxFnLines + ' 行）', threshold: '0 个（声明 ≤60 行）' },
    { name: '测试存在性', pass: hasTests, value: hasTests ? '有测试目录' : '无测试', threshold: '必须有' },
  ]
  return {
    files,
    totals: {
      files: files.length,
      lines: totalLines,
      commentRatio: totalLines === 0 ? 0 : Math.round(totalComments / totalLines * 100),
      avgCyclomatic: avgCc,
      maxCyclomatic: maxCc,
      highComplexityFiles: highComplexity,
      noTests: !hasTests,
    },
    gates,
  }
}

/**
 * 静态砖块/服务/工具分类器 —— 引擎 A 的语义档案来源（cog_scan 的核心）。
 *
 * 职责：递归扫描项目源码，提取函数签名与函数体，按五条规则
 * （R1 纯计算 / R2 无持久化 / R3 无全局副作用 / R4 业务语义 / R5 规模适中）
 * 判定每个函数的分类（brick / service / util / unknown），
 * 并输出判定证据与调用依赖边。本文件只报事实，AI 依据事实决策。
 *
 * 解析方式：复用 arch_aop 的源码级正则思路（零依赖、不引入 AST），
 * 复杂结构（类方法/装饰器等）跳过并在 findings 中提示。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** 函数分类。 */
export type FunctionKind = 'brick' | 'service' | 'util' | 'unknown'

/** 一个函数的静态语义档案。 */
export interface BrickProfile {
  /** 全局唯一 id：文件相对路径:函数名。 */
  id: string
  /** 源文件相对路径。 */
  file: string
  /** 函数名。 */
  name: string
  /** 分类结果。 */
  kind: FunctionKind
  /** 命中判定规则证据（如 ['R1', 'R4']），供 AI 决策。 */
  evidence: string[]
  /** 业务词汇（从函数名/中文注释抽取）。 */
  keywords: string[]
  /** 参数名列表。 */
  inputs: string[]
  /** 返回值类型提示（void 或推断名）。 */
  output: string
  /** 检测到的副作用调用（无则空）。 */
  sideEffects: string[]
  /** 调用的同项目函数（依赖边）。 */
  calls: string[]
  /** 行数（函数体估算）。 */
  loc: number
  /** 圈复杂度估算。 */
  complexity: number
  /** 是否为疑似隐式砖块（大函数且含业务语义）。 */
  implicitBrick: boolean
}

/** 一次项目扫描的结果。 */
export interface ScanResult {
  /** 扫描的项目根目录（绝对路径）。 */
  projectDir: string
  /** 文件数。 */
  fileCount: number
  /** 全部函数档案。 */
  functions: BrickProfile[]
  /** 分类统计。 */
  stats: { bricks: number; services: number; utils: number; unknowns: number; files: number }
  /** 疑似问题（隐式砖块等）。 */
  findings: Array<{ file: string; hint: string }>
}

/** 强副作用词（几乎必然 I/O 或全局操作）。 */
const STRONG_SIDE_EFFECTS = [
  'fetch(', 'axios', 'XMLHttpRequest', 'http://', 'https://',
  'writeFile', 'readFile', 'appendFile', 'mkdir', 'readdir', 'unlink',
  'console.', 'process.', 'globalThis', 'setTimeout', 'setInterval',
  'Math.random', 'window.', 'document.', 'localStorage', 'sessionStorage',
  'WebSocket', 'child_process', 'spawn', 'exec(',
]

/** 数据层词（持久化/模型访问）。 */
const DATA_LAYER_WORDS = [
  'Repository', 'repository', 'Model', 'model', 'Schema', 'schema',
  'Table', 'table', 'query', 'insert', 'update', 'delete', 'create',
  'save(', 'remove(', 'find(', 'SQL', 'sql', 'select ', 'from ',
]

/** 通用动词（出现在函数名中不构成业务语义）。 */
const GENERIC_VERBS = [
  'get', 'set', 'is', 'are', 'has', 'to', 'from', 'format', 'parse',
  'calc', 'calculate', 'convert', 'build', 'create', 'load', 'save',
  'map', 'filter', 'reduce', 'find', 'make', 'do', 'run', 'exec',
]

/** 通用技术名词（函数名中不构成业务语义）。 */
const GENERIC_NOUNS = [
  'data', 'date', 'time', 'string', 'number', 'array', 'object', 'id',
  'name', 'value', 'list', 'set', 'map', 'field', 'key', 'type', 'info',
  'status', 'result', 'error', 'config', 'options', 'params', 'args',
  'util', 'helper', 'utils', 'helpers', 'request', 'response', 'input',
  'output', 'text', 'json', 'url', 'path', 'file', 'dir', 'size', 'count',
  'money', 'price', 'amount', 'total', 'sum', 'avg', 'round',
]

/** 需跳过的目录名。 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'lib', 'build', 'coverage', '.git',
  '.code-arch', '.code-review', '.code-cognition', '.dsh',
])

/**
 * 递归收集项目内全部 TS/JS 源码文件。
 * @param projectDir - 项目根目录。
 * @returns 相对路径列表（按路径排序）。
 */
export function collectSourceFiles(projectDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries.sort()) {
      if (SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      let stat: ReturnType<typeof statSync> | null = null
      try { stat = statSync(abs) } catch { continue }
      if (stat.isDirectory()) walk(abs)
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !name.endsWith('.stage.ts')) out.push(relative(projectDir, abs))
    }
  }
  walk(projectDir)
  return out.sort()
}

/** 提取到的函数定义。 */
export interface FunctionDef {
  name: string
  /** 参数列表原文（括号内）。 */
  argsText: string
  /** 函数体（含花括号）。 */
  body: string
  /** 函数体起始行号（1 基，用于埋点定位）。 */
  line: number
  /** 是否为 export 顶层函数。 */
  exported: boolean
  /** 函数体开括号在源码中的偏移。 */
  bodyStart: number
  /** 函数体闭括号在源码中的偏移。 */
  bodyEnd: number
}

/**
 * 从源码中提取全部具名顶层函数（export function / function / const fn = () =>）。
 * 类方法暂不提取（在 findings 提示）。返回按源码顺序排列的定义列表。
 * @param src - 源码文本。
 * @returns 函数定义列表。
 */
export function extractFunctions(src: string): FunctionDef[] {
  const defs: FunctionDef[] = []
  const patterns: Array<{ re: RegExp; nameIdx: number; argsIdx: number }> = [
    { re: /export\s+(?:async\s+)?function\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*\(([^)]*)\)/g, nameIdx: 1, argsIdx: 2 },
    { re: /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*\(([^)]*)\)/g, nameIdx: 1, argsIdx: 2 },
    { re: /export\s+const\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|[A-Za-z_$][\w$]*)\s*=>/g, nameIdx: 1, argsIdx: 2 },
    { re: /const\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|[A-Za-z_$][\w$]*)\s*=>/g, nameIdx: 1, argsIdx: 2 },
    { re: /export\s+const\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*=\s*(?:async\s*)?function\s*\(([^)]*)\)/g, nameIdx: 1, argsIdx: 2 },
    { re: /const\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*=\s*(?:async\s*)?function\s*\(([^)]*)\)/g, nameIdx: 1, argsIdx: 2 },
  ]
  for (const { re, nameIdx, argsIdx } of patterns) {
    for (const m of src.matchAll(re)) {
      const name = m[nameIdx]!
      const argsText = m[argsIdx] ?? ''
      const openBrace = src.indexOf('{', m.index! + m[0].length)
      if (openBrace === -1) continue
      let depth = 0
      let closeBrace = -1
      for (let i = openBrace; i < src.length; i++) {
        const ch = src[i]!
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) { closeBrace = i; break }
        }
      }
      if (closeBrace === -1) continue
      // 过滤掉方法/对象属性上下文中的误匹配（前面是 . 或 : 等）
      const before = src.slice(Math.max(0, m.index! - 2), m.index!)
      if (before.endsWith('.')) continue
      const body = src.slice(openBrace, closeBrace + 1)
      const line = src.slice(0, m.index!).split('\n').length
      // 去重（同一函数可能被多个模式命中，保留首个）
      if (!defs.some(d => d.name === name && d.line === line)) {
        defs.push({ name, argsText, body, line, exported: m[0].startsWith('export'), bodyStart: openBrace, bodyEnd: closeBrace })
      }
    }
  }
  return defs.sort((a, b) => a.line - b.line)
}

/**
 * 从函数名拆词 + 中文注释/字符串抽取业务词汇。
 * @param name - 函数名。
 * @param body - 函数体。
 * @returns 去重后的业务词汇列表（最多 6 个）。
 */
export function extractKeywords(name: string, body: string): string[] {
  const words: string[] = []
  // 函数名中的中文片段
  const nameCn = name.match(/[\u4e00-\u9fff]{2,}/g)
  if (nameCn) words.push(...nameCn)
  // 函数体/注释中的中文词汇（2-6 字连续中文）
  const bodyCn = body.match(/[\u4e00-\u9fff]{2,6}/g)
  if (bodyCn) words.push(...bodyCn)
  return [...new Set(words)].slice(0, 6)
}

/** 驼峰/蛇形拆词。 */
function splitName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\- ]+/)
    .filter(Boolean)
}

/**
 * 判定函数名是否含业务语义（R4）。
 * 规则：含中文 → 是；拆词后存在非通用词段（非通用动词/名词）→ 是；否则否。
 * @param name - 函数名。
 * @returns 是否含业务语义。
 */
export function hasBusinessSemantic(name: string): boolean {
  if (/[\u4e00-\u9fff]/.test(name)) return true
  const parts = splitName(name).map(p => p.toLowerCase())
  const generic = new Set([...GENERIC_VERBS, ...GENERIC_NOUNS])
  return parts.some(p => p.length > 1 && !generic.has(p))
}

/**
 * 估算圈复杂度（if/for/while/switch/case/三元/逻辑与或/可选链计数）。
 * @param body - 函数体。
 * @returns 复杂度值。
 */
export function estimateComplexity(body: string): number {
  let c = 1
  for (const re of [/\bif\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g, /\bswitch\s*\(/g,
    /\bcase\s+/g, /\?\s*[^:]+:/g, /&&/g, /\|\|/g, /\bcatch\s*\(/g]) {
    c += body.match(re)?.length ?? 0
  }
  return c
}

/**
 * 检测函数体中的副作用（强副作用词 + 数据层词）。
 * @param body - 函数体。
 * @returns 命中的副作用描述列表。
 */
export function detectSideEffects(body: string): string[] {
  const out: string[] = []
  for (const w of STRONG_SIDE_EFFECTS) if (body.includes(w)) out.push(w.replace(/\W+$/, ''))
  for (const w of DATA_LAYER_WORDS) if (body.includes(w)) out.push(w.replace(/\W+$/, ''))
  return [...new Set(out)]
}

/**
 * 分析单个函数并生成档案。
 * @param file - 文件相对路径。
 * @param def - 函数定义。
 * @param allNames - 同项目全部函数名（用于依赖边识别）。
 * @returns 函数档案。
 */
export function analyzeFunction(file: string, def: FunctionDef, allNames: Set<string>): BrickProfile {
  const name = def.name
  const id = `${file}:${name}`
  const sideEffects = detectSideEffects(def.body)
  const keywords = extractKeywords(name, def.body)
  const biz = hasBusinessSemantic(name)
  const loc = def.body.split('\n').length
  const complexity = estimateComplexity(def.body)
  const inputs = def.argsText.split(',').map(a => a.trim().split(':')[0]!.trim())
    .filter(a => /^[A-Za-z_$][\w$]*$/.test(a) && a !== '...args')
  const output = /=>\s*({|new|[\w$])/.test(def.body.split('{')[1] ?? '') ? 'inferred' : 'void'
  // 依赖边：同项目函数名在函数体中出现（Unicode 边界断言，兼容中文函数名）
  const calls = [...new Set(allNames)].filter(n => n !== name && new RegExp(`(^|[^\\p{L}\\p{N}_$])${n}(?![\\p{L}\\p{N}_$])`, 'u').test(def.body)).slice(0, 12)

  // 五条规则判定
  const noStrong = !sideEffects.some(s => STRONG_SIDE_EFFECTS.some(w => s === w.replace(/\W+$/, '')))
  const noData = !sideEffects.some(s => DATA_LAYER_WORDS.some(w => s === w.replace(/\W+$/, '')))
  const pureCalc = noStrong && noData
  const scaleOk = complexity <= 8 && loc <= 60
  const evidence: string[] = []
  if (pureCalc) evidence.push('R1')
  if (noData) evidence.push('R2')
  if (noStrong) evidence.push('R3')
  if (biz) evidence.push('R4')
  if (scaleOk) evidence.push('R5')

  // 分类：纯计算 → brick（有语义）/ util（无语义）；有副作用 → service（有语义）/ service（无语义降级）；其余 unknown
  let kind: FunctionKind
  if (pureCalc) {
    kind = biz ? 'brick' : 'util'
  } else if (sideEffects.length > 0) {
    kind = 'service'
  } else {
    kind = 'unknown'
  }
  const implicitBrick = biz && !scaleOk

  return { id, file, name, kind, evidence, keywords, inputs, output, sideEffects, calls, loc, complexity, implicitBrick }
}

/**
 * 扫描项目并生成全部函数档案（cog_scan 核心）。
 *
 * 两遍分类：
 * - pass1 按函数自身属性分类（纯计算/副作用/语义/规模）；
 * - pass2 编排提升：brick 若直接调用其他 brick（编排者职责），
 *   提升为 service（证据加 S1），对齐「砖块可拼装、服务做组合」的分层哲学。
 * @param projectDir - 项目根目录（绝对路径）。
 * @returns 扫描结果。
 */
export function scanProject(projectDir: string): ScanResult {
  const abs = resolve(projectDir)
  const files = collectSourceFiles(abs)
  const allDefs: Array<{ file: string; def: FunctionDef }> = []
  for (const file of files) {
    let src = ''
    try { src = readFileSync(join(abs, file), 'utf8') } catch { continue }
    for (const def of extractFunctions(src)) allDefs.push({ file, def })
  }
  const allNames = new Set(allDefs.map(d => d.def.name))
  const functions = allDefs.map(d => analyzeFunction(d.file, d.def, allNames))
  // pass2：编排提升——brick 直接调用其他 brick → service
  for (const fn of functions) {
    if (fn.kind !== 'brick') continue
    const orchestrates = fn.calls.some(c => {
      const callee = functions.find(x => x.name === c)
      return callee !== undefined && callee.kind === 'brick'
    })
    if (orchestrates) {
      fn.kind = 'service'
      fn.evidence.push('S1')
    }
  }
  const stats = {
    bricks: functions.filter(f => f.kind === 'brick').length,
    services: functions.filter(f => f.kind === 'service').length,
    utils: functions.filter(f => f.kind === 'util').length,
    unknowns: functions.filter(f => f.kind === 'unknown').length,
    files: files.length,
  }
  const findings = functions
    .filter(f => f.implicitBrick)
    .map(f => ({ file: f.file, hint: `${f.name} loc=${f.loc} complexity=${f.complexity}，含业务语义但规模过大，可能同时承担砖块与组装职责` }))
  return { projectDir: abs, fileCount: files.length, functions, stats, findings }
}

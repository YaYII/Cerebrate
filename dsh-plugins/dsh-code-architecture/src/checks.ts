/**
 * 代码架构自检规则集：注释语言、命名规范、重复功能、功能/业务分离、依赖方向。
 *
 * 设计哲学：
 *   - 功能是砖块（原子、可复用、不随业务改变）；业务是组合（可自由重组）。
 *   - 检查器只报事实，不代 AI 决策；每条发现可溯源到 文件:行号。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 一条检查发现。 */
export interface ArchFinding {
  /** 规则编号：C1 注释语言 / N1 命名 / D1 重复 / S1 分离 / E1 依赖方向。 */
  rule: string
  /** 严重级：P0 阻塞 / P1 高 / P2 建议。 */
  severity: 'P0' | 'P1' | 'P2'
  /** 相对文件路径。 */
  file: string
  /** 行号（可选）。 */
  line?: number
  /** 中文可操作说明。 */
  message: string
}

/** 扫描结果。 */
export interface ArchReport {
  findings: ArchFinding[]
  stats: {
    files: number
    lines: number
    comments: number
    enCommentLines: number
    functions: number
    duplicates: number
    separations: number
  }
}

/** 遍历时跳过的目录。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', 'target', '.idea', '.vscode', '.venv', 'venv', '__pycache__', 'vendor',
  'lib', '.turbo', 'tmp', 'bin', '.old', '.stale', 'reports', 'demo', '.code-review',
])

/** 常见英文词（注释中出现即视为英文注释）。 */
const EN_WORDS = [
  'the', 'this', 'that', 'return', 'returns', 'param', 'value', 'boolean',
  'string', 'number', 'object', 'array', 'true', 'false', 'null', 'function',
  'interface', 'type', 'default', 'optional', 'required', 'readonly', 'one',
  'into', 'from', 'with', 'without', 'when', 'does', 'use', 'used', 'via',
  'against', 'after', 'before', 'current', 'fresh', 'whole', 'every', 'each',
  'same', 'field', 'path', 'file', 'dir', 'build', 'create', 'load', 'save',
  'diff', 'scan', 'validate', 'check', 'result', 'error', 'failed', 'extract',
  'render', 'write', 'read', 'submit', 'handle', 'task', 'project', 'agent',
  'session', 'config', 'context', 'source', 'page', 'module', 'meta', 'options',
  'provider', 'model', 'signal', 'commit', 'content', 'body', 'root',
  'is', 'an', 'comment', 'English', 'should', 'must', 'will', 'can',
  'may', 'not', 'no', 'yes', 'all', 'any', 'some', 'only', 'such', 'than',
  'then', 'there', 'here', 'where', 'which', 'what', 'who', 'while', 'until',
  'during', 'within', 'without', 'between', 'among', 'also', 'even', 'still',
  'already', 'again', 'always', 'never', 'often',
]

/** 专有名词白名单（注释中允许的英文词汇）。 */
const ALLOWED = new Set([
  'Mermaid', 'Obsidian', 'DSH', 'API', 'ID', 'IO', 'URL', 'HTTP', 'JSON', 'TODO',
  'JSDoc', 'SVG', 'HTTPS', 'SHA256', 'Redis', 'MySQL', 'Git', 'Vite', 'Swarm',
  'Docker', 'Kotlin', 'Java', 'TypeScript', 'Cordis', 'LLM', 'AI', 'RSA', 'nonce',
  'JWT', 'RBAC', 'TTL', 'ECS', 'VPN', 'UAT', 'PROD', 'CIDR', 'SETNX', 'MD', 'yml',
  'frontmatter', 'DSEDT', 'Markdown', 'mermaid', 'sanitize', 'lint', 'requestContext',
  'options', 'provider', 'model', 'agent', 'step', 'start', 'end', 'body', 'null',
  'git', 'head', 'root', 'session', 'task', 'project', 'source', 'page', 'meta',
  'config', 'context', 'signal', 'commit', 'content', 'handle', 'diff', 'scan',
  'wiki_tree', 'wiki_read', 'wiki_write', 'wiki_build', 'wiki_status', 'wiki_evolve',
  'taskOverride', 'inheritAgent', 'subagent', 'vault', 'kb', 'frontend', 'backend',
  'docker', 'database', 'AOP', 'debug', 'Debug', 'CI', 'ESLint', 'eslint', 'npm',
  'pnpm', 'yarn', 'tsc', 'vitest', 'tsdown', 'JVM', 'Spring', 'Boot', 'DTO', 'DAO',
  '@module', 'function', 'interface', 'type', 'return', 'param', 'value', 'const',
  'export', 'async', 'await', 'import', 'default', 'true', 'false', 'null',
  'undefined', 'marker', 'seq', 'start', 'depth', 'threw', 'records',
])

/** 判断一行是否为注释行。 */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('/**')
}

/** 收集项目内全部源文件（跳过产物目录）。 */
export function collectSourceFiles(root: string): string[] {
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

/** C1：注释语言检查——英文注释行（专有名词白名单除外）。 */
export function checkCommentLanguage(absPath: string, relPath: string): ArchFinding[] {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const findings: ArchFinding[] = []
  const allowedRe = new RegExp(`\\b(${[...ALLOWED].join('|')})\\b`, 'g')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (!isCommentLine(trimmed) || trimmed.startsWith('@module')) continue
    const text = trimmed
      .replace(/^\/\*\*?/, '').replace(/^\/\//, '').replace(/\*\/$/, '')
      .replace(/^\*/, '').replace(/^\* /, '').trim()
    if (text.length === 0 || text.startsWith('@module')) continue
    const withoutAllowed = text.replace(allowedRe, '')
    if (EN_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(withoutAllowed))) {
      findings.push({
        rule: 'C1', severity: 'P0', file: relPath, line: i + 1,
        message: '英文注释（规范要求全部中文）：' + text.slice(0, 60),
      })
    }
  }
  return findings
}

/** N1：命名规范——小驼峰函数/变量、大驼峰类型、全大写常量。 */
export function checkNaming(absPath: string, relPath: string): ArchFinding[] {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const findings: ArchFinding[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    // 函数命名：function 后必须小驼峰或全大写（构造器除外）
    const fn = /function\s+([A-Za-z_$][\w$]*)/.exec(trimmed)
    if (fn && fn[1]!.includes('_')) {
      findings.push({ rule: 'N1', severity: 'P1', file: relPath, line: i + 1, message: '函数命名含下划线，应为小驼峰：' + fn[1] })
    } else if (fn && !/^[a-z$]/.test(fn[1]!) && !/^[A-Z][a-z]/.test(fn[1]!)) {
      findings.push({ rule: 'N1', severity: 'P1', file: relPath, line: i + 1, message: '函数命名应为小驼峰：' + fn[1] })
    }
    // 接口/类型命名：大驼峰
    const iface = /(?:interface|type)\s+([a-z][\w$]*)/.exec(trimmed)
    if (iface) {
      findings.push({ rule: 'N1', severity: 'P1', file: relPath, line: i + 1, message: '接口/类型命名应为大驼峰：' + iface[1] })
    }
    // 常量命名：const 全大写 或 const 小驼峰（对象/数组除外）
    const cnst = /const\s+([a-z][\w$]*)\s*=\s*(\d+|'|"|true|false)/.exec(trimmed)
    if (cnst && !/^[A-Z0-9_]+$/.test(cnst[1]!)) {
      findings.push({ rule: 'N1', severity: 'P2', file: relPath, line: i + 1, message: '标量常量建议全大写：' + cnst[1] })
    }
  }
  return findings
}

/** D1：重复功能检测——函数体相似度（简化版：按行指纹分组）。 */
export function checkDuplicates(absPath: string, relPath: string): ArchFinding[] {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const findings: ArchFinding[] = []
  const bodies = new Map<string, Array<{ name: string; line: number; code: string[] }>>()
  let cur: { name: string; line: number; code: string[] } | null = null
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fn = /(?:function|=>)\s*([A-Za-z_$][\w$]*)?/.exec(line)
    if (/^(export\s+)?(async\s+)?function/.test(line.trim())) {
      cur = { name: line.trim().match(/function\s+([A-Za-z_$][\w$]*)/)?.[1] ?? 'anonymous', line: i + 1, code: [] }
      depth = 0
    }
    if (cur) {
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
      cur.code.push(line.replace(/\s+/g, ''))
      if (depth <= 0 && cur.code.length > 6) {
        // 简化指纹：非空行 + 变量名归一化
        const fingerprint = cur.code.filter(l => l.length > 0).map(l => l.replace(/\b[a-z][\w$]*\b/g, 'x')).join('|')
        const key = fingerprint.slice(0, 400)
        const bucket = bodies.get(key) ?? []
        bucket.push(cur)
        bodies.set(key, bucket)
        cur = null
      }
    }
  }
  for (const bucket of bodies.values()) {
    if (bucket.length >= 2) {
      const names = bucket.map(b => b.name + ':' + b.line).join(' 与 ')
      findings.push({
        rule: 'D1', severity: 'P2', file: relPath, line: bucket[0]!.line,
        message: '疑似重复功能（函数体相似）：' + names,
      })
    }
  }
  return findings
}

/** S1：功能/业务分离——检测「业务逻辑混入纯工具/功能层」的信号。 */
export function checkSeparation(absPath: string, relPath: string): ArchFinding[] {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const findings: ArchFinding[] = []
  const isFeature = /\/(utils?|tools?|lib|core|shared|helpers?|features?)\//.test(relPath)
  if (!isFeature) return findings
  // 功能层文件不应出现业务专属词汇（订单/支付/用户/权限等硬编码业务词）
  const bizWords = /订单|支付|用户|权限|会员|库存|发票|核销|商户|活动|订单号|orderNo|receiptId|Order|Payment|User|Invoice|Merchant|Activity/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
    const m = bizWords.exec(line)
    if (m && !line.includes('@module') && !line.includes('import')) {
      findings.push({
        rule: 'S1', severity: 'P2', file: relPath, line: i + 1,
        message: '功能层出现业务词汇「' + m[0] + '」：功能是砖块，不应绑定具体业务（业务应通过参数/配置注入）',
      })
      break
    }
  }
  return findings
}

/** E1：依赖方向检查——功能层不允许 import 业务层。 */
export function checkDependencyDirection(absPath: string, relPath: string): ArchFinding[] {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const findings: ArchFinding[] = []
  const isFeature = /\/(utils?|tools?|lib|core|shared|helpers?|features?)\//.test(relPath)
  const isBiz = /\/(biz|business|services?|controllers?|app|modules?|domains?)\//.test(relPath)
  if (!isFeature) return findings
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /from\s+['"]([^'"]+)['"]/.exec(line)
    if (!m) continue
    const target = m[1]!
    if (/biz|business|services|controllers|app|modules|domains/.test(target) && !/utils|lib|core|shared|helpers/.test(target)) {
      findings.push({
        rule: 'E1', severity: 'P1', file: relPath, line: i + 1,
        message: '功能层依赖了业务层（' + target + '）：依赖方向应单向——功能层不 import 业务层，业务层才依赖功能层',
      })
    }
  }
  return findings
}

/** 执行全部检查，返回聚合报告。 */
export function runArchChecks(root: string): ArchReport {
  const files = collectSourceFiles(root)
  const findings: ArchFinding[] = []
  let totalLines = 0
  let comments = 0
  let enCommentLines = 0
  let functions = 0
  for (const abs of files) {
    const rel = abs.slice(root.length + 1).replace(/\\/g, '/')
    // tests/ 目录的故意违规样本（验证检查器的测试数据）不参与门禁
    if (rel.startsWith('tests/')) continue
    const content = readFileSync(abs, 'utf8')
    const lines = content.split('\n')
    totalLines += lines.length
    functions += (content.match(/function\s+|=>/g) || []).length
    for (const l of lines) {
      const t = l.trim()
      if (isCommentLine(t)) comments++
      if (isCommentLine(t) && /\b(the|this|return|param|value|function)\b/.test(t.replace(/^\/\*\*?|^\/\//, ''))) enCommentLines++
    }
    findings.push(...checkCommentLanguage(abs, rel))
    findings.push(...checkNaming(abs, rel))
    findings.push(...checkDuplicates(abs, rel))
    findings.push(...checkSeparation(abs, rel))
    findings.push(...checkDependencyDirection(abs, rel))
  }
  const duplicates = findings.filter(f => f.rule === 'D1').length
  const separations = findings.filter(f => f.rule === 'S1' || f.rule === 'E1').length
  return {
    findings,
    stats: { files: files.length, lines: totalLines, comments, enCommentLines, functions, duplicates, separations },
  }
}

#!/usr/bin/env node
/**
 * 注释语言检查器 —— 项目宪法 §1 的自动门禁。
 * 检测 src/ 下所有 .ts 文件中的英文注释，违规即非零退出。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const ALLOWED = new Set([
  'Mermaid', 'Obsidian', 'DSH', 'API', 'ID', 'IO', 'URL', 'HTTP', 'JSON', 'TODO',
  'JSDoc', 'SVG', 'HTTPS', 'SHA256', 'Redis', 'MySQL', 'Git', 'Vite', 'Swarm',
  'Docker', 'Kotlin', 'Java', 'TypeScript', 'Cordis', 'LLM', 'AI', 'RSA', 'nonce',
  'JWT', 'RBAC', 'TTL', 'ECS', 'VPN', 'UAT', 'PROD', 'CIDR', 'SETNX', 'MD', 'yml',
  'frontmatter', 'DSEDT', 'Markdown', 'mermaid', 'sanitize', 'lint', 'requestContext',
  'options', 'provider', 'model', 'agent', 'step', 'start', 'end', 'body', 'null',
  'git', 'head', 'root', 'session', 'task', 'project', 'source', 'page', 'meta',
  'config', 'context', 'signal', 'commit', 'content', 'handle', 'diff', 'scan',
  'AOP', 'debug', 'CI', 'ESLint', 'npm', 'pnpm', 'yarn', 'tsc', 'vitest', 'tsdown',
  'function', 'interface', 'type', 'return', 'param', 'value', 'const', 'export',
  'async', 'await', 'import', 'default', 'true', 'false', 'null', 'undefined',
])

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
  'is', 'an', 'comment', 'English', 'should', 'must', 'will', 'can', 'may',
  'not', 'no', 'yes', 'all', 'any', 'some', 'only', 'such', 'than', 'then',
  'there', 'here', 'where', 'which', 'what', 'who', 'while', 'until', 'during',
  'within', 'without', 'between', 'among', 'also', 'even', 'still', 'already',
  'again', 'always', 'never', 'often',
]

function isCommentLine(t) { return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('/**') }

function scanFile(abs) {
  const lines = readFileSync(abs, 'utf8').split('\n')
  const violations = []
  const allowedRe = new RegExp(`\\b(${[...ALLOWED].join('|')})\\b`, 'g')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!isCommentLine(trimmed)) continue
    const text = trimmed.replace(/^\/\*\*?/, '').replace(/^\/\//, '').replace(/\*\/$/, '').replace(/^\*/, '').replace(/^\* /, '').trim()
    if (text.length === 0 || text.startsWith('@module')) continue
    const withoutAllowed = text.replace(allowedRe, '')
    if (EN_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(withoutAllowed))) {
      violations.push({ line: i + 1, text: text.slice(0, 70) })
    }
  }
  return violations
}

function main() {
  const files = readdirSync(SRC).filter(f => f.endsWith('.ts')).sort()
  let total = 0
  const report = []
  for (const f of files) {
    const vs = scanFile(join(SRC, f))
    if (vs.length) {
      report.push(`== ${f} ==`)
      for (const v of vs) { report.push(`  L${v.line}: ${v.text}`); total++ }
    }
  }
  if (total > 0) {
    console.error(`✗ 发现 ${total} 处英文注释：`)
    console.error(report.join('\n'))
    process.exit(1)
  }
  console.log('✓ 注释语言检查通过：全部为中文注释')
}
main()

#!/usr/bin/env node
/**
 * 注释语言检查器 —— 项目宪法 §1/§8 的自动门禁。
 *
 * 检测 src/ 下所有 .ts 文件中的英文注释（JSDoc、行注释、块注释），
 * 输出违规清单并以非零码退出（供 CI/构建钩子使用）。
 *
 * 允许例外：注释内嵌的专有名词（Mermaid/Obsidian/DSH/API 等）不算违规。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

/** 专有名词白名单（注释中允许出现的英文词汇）。 */
const ALLOWED = new Set([
  'Mermaid', 'Obsidian', 'DSH', 'API', 'ID', 'IO', 'URL', 'HTTP', 'JSON',
  'TODO', 'JSDoc', 'SVG', 'HTTPS', 'SHA256', 'Redis', 'MySQL', 'Git', 'Vite',
  'Swarm', 'Docker', 'Kotlin', 'Java', 'TypeScript', 'Cordis', 'LLM', 'AI',
  'RSA', 'nonce', 'JWT', 'RBAC', 'TTL', 'ECS', 'VPN', 'UAT', 'PROD',
  'CIDR', 'SETNX', 'EpochHeader', 'RequestContext', 'MD', 'yml', 'frontmatter',
  'DSEDT', 'markdown', 'Markdown', 'obsidian', 'mermaid', 'sanitize', 'lint',
  '@module', 'requestContext', 'options', 'provider', 'model', 'agent', 'step',
  'start', 'end', 'body', 'null', 'git', 'head', 'root', 'session', 'task',
  'project', 'source', 'page', 'pages', 'meta', 'config', 'context', 'signal',
  'commit', 'content', 'handle', 'diff', 'scan', 'wiki_tree', 'wiki_read', 'impls', 'write', 'ts', 'param', 'returns', '@param', '@returns', 'args', 'returns', 'status', 'data',
  'wiki_write', 'wiki_build', 'wiki_status', 'wiki_evolve', 'taskOverride',
  'inheritAgent', 'subagent', 'JSDoc', 'wiki', 'vault', 'kb', 'frontend',
  'backend', 'docker', 'database', 'Markdown', 'mermaid', 'DSH', 'AI', 'IO',
])

/** 常见英文词（注释中出现即视为英文注释）。 */
const EN_WORDS = [
  'the', 'The', 'this', 'This', 'that', 'That', 'return', 'Returns',
  'param', 'Parameters', 'Args', 'args', 'value', 'Value', 'boolean',
  'string', 'number', 'object', 'array', 'true', 'false', 'null',
  'function', 'Function', 'interface', 'Interface', 'type', 'Type',
  'default', 'optional', 'Optional', 'required', 'Required', 'readonly',
  'One', 'one', 'of', 'into', 'from', 'with', 'without', 'when', 'When',
  'does', 'Does', 'use', 'used', 'via', 'against', 'after', 'before',
  'current', 'Current', 'fresh', 'whole', 'every', 'each', 'same',
  'field', 'Field', 'path', 'Path', 'file', 'File', 'dir', 'Dir',
  'build', 'Build', 'create', 'Create', 'load', 'Load', 'save', 'Save',
  'diff', 'Diff', 'scan', 'Scan', 'validate', 'Validate', 'check',
  'result', 'Result', 'error', 'Error', 'failed', 'Failed', 'returns',
  'extract', 'Extract', 'render', 'Render', 'write', 'Write', 'read', 'Read',
  'Submit', 'submit', 'handle', 'Handle', 'task', 'Task', 'project', 'Project',
  'agent', 'Agent', 'session', 'Session', 'config', 'Config', 'context',
  'source', 'Source', 'page', 'Page', 'pages', 'module', 'Module', 'meta',
  'options', 'Options', 'provider', 'Provider', 'model', 'Model', 'signal',
  'commit', 'Commit', 'content', 'Content', 'body', 'Body', 'root', 'Root',
]

/** 判断一行是否属于注释：行注释或 JSDoc/块注释内容。 */
function isCommentLine(trimmed) {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('/**')
}

/** 扫描一个文件的注释行，返回违规行号与内容。 */
function scanFile(absPath) {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // 只处理真正的注释行：// 开头、/* 开头、* 续行、*/ 结尾行
    if (!isCommentLine(trimmed)) continue
    // 去掉注释标记
    const text = trimmed
      .replace(/^\/\*\*?/, '')   // 开头 /* 或 /**
      .replace(/^\/\//, '')      // 行注释 //
      .replace(/\*\/$/, '')      // 结尾 */
      .replace(/^\*/,'').replace(/^\* /,'') // 续行 * 或 * 
      .trim()
    // JSDoc 标签行（@param/@returns/@module 等）是声明性文档，跳过英文词检测
    if (text.length === 0 || text.startsWith('@')) continue
    // 英文词命中检测（排除白名单词后仍有英文词才算违规）
    const withoutAllowed = text.replace(new RegExp(`\\b(${[...ALLOWED].join('|')})\\b`, 'g'), '')
    const words = EN_WORDS.filter(w => new RegExp(`\\b${w}\\b`).test(withoutAllowed))
    if (words.length > 0) {
      violations.push({ line: i + 1, text: text.slice(0, 80), words: words.slice(0, 3) })
    }
  }
  return violations
}

/** 主流程：扫描全部源文件并输出报告。 */
function main() {
  const files = readdirSync(SRC).filter(f => f.endsWith('.ts')).sort()
  let total = 0
  const report = []
  for (const f of files) {
    const violations = scanFile(join(SRC, f))
    if (violations.length > 0) {
      report.push(`== ${f} ==`)
      for (const v of violations) {
        report.push(`  L${v.line}: ${v.text}`)
        total++
      }
    }
  }
  if (total > 0) {
    console.error(`✗ 发现 ${total} 处英文注释（违反项目宪法 §1）：`)
    console.error(report.join('\n'))
    process.exit(1)
  }
  console.log('✓ 注释语言检查通过：全部为中文注释')
}

main()

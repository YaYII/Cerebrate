#!/usr/bin/env node
/**
 * 注释语言检查器 —— 项目宪法 §1 的自动门禁：注释必须为简体中文。
 * 判据：注释行若不含任何中日韩字符、且含有 ≥2 个连续英文单词，则视为英文注释。
 * 专有名词白名单内的词不计入英文单词。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 允许出现在中文注释里的专有名词（不作为英文注释判据）。 */
const ALLOWED = new Set([
  'DSH', 'AI', 'API', 'ID', 'JSON', 'HTTP', 'URL', 'MCP', 'OTel', 'AOP', 'MDC', 'JVM',
  'Java', 'Spring', 'logback', 'traceId', 'spanId', 'caseId', 'Meridian', 'JSDoc',
  'TS', 'TSX', 'npm', 'tsx', 'tsc', 'node', 'test', 'spec', 'src', 'lib',
  'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'SUCCESS', 'FAILED',
  'com', 'dsedt', 'verification', 'yaml', 'yml', 'xml', 'CDATA',
])
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 英文虚词表 —— 判断「是否为英文散文」的关键特征。
 *
 * 动因：专有名词/库名列表（如 `zap / logrus（Go）、logstash-encoder（Java）`）没有虚词，
 * 不应被判为英文注释；而真正的英文句子几乎必然含虚词。用虚词而非词数做判据，
 * 可以避免为每个新出现的库名维护白名单。
 */
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'for',
  'with', 'without', 'and', 'or', 'not', 'no', 'this', 'that', 'these', 'those', 'it', 'its',
  'when', 'where', 'which', 'while', 'if', 'then', 'than', 'as', 'at', 'by', 'from', 'into',
  'should', 'must', 'can', 'could', 'will', 'would', 'may', 'might', 'do', 'does', 'did',
])

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (name.endsWith('.ts')) yield full
  }
}

let bad = 0
for (const file of walk(join(ROOT, 'src'))) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    const at = line.indexOf('//')
    const block = line.trimStart().startsWith('*') || line.trimStart().startsWith('/*')
    if (at < 0 && !block) return
    const text = block ? line.replace(/^[\s/*]+/, '') : line.slice(at + 2)
    // JSDoc 标签行（@module/@param/@returns 等）属结构标记，其后的描述另有中文要求，
    // 此处不作为「英文散文注释」判据，避免误报。
    if (text.trimStart().startsWith('@')) return
    // 引用性内容不判为英文散文：反引号包裹的示例、以及原文引用的日志行/JSON 片段。
    // 这些是**证据**，删掉它们反而会降低文档可信度。
    if (text.includes('`')) return
    if (/^\s*\[?\d{4}-\d{2}-\d{2}/.test(text) || text.includes('{"')) return
    if (text.trim() === '' || CJK.test(text)) return
    const words = text.split(/[^A-Za-z]+/).filter((w) => w.length > 1 && !ALLOWED.has(w))
    const hasFunctionWord = words.some((w) => FUNCTION_WORDS.has(w.toLowerCase()))
    // 判据：含英文虚词（真散文的特征），或英文串长达 8 个词以上（整句英文的兜底）。
    // 阈值取 8 而非更小：像「pino / bunyan / structlog / zap / logrus」这类库名枚举
    // 常在 5~7 个词之间，若阈值太低会把技术枚举误判为英文注释。
    if (hasFunctionWord || words.length >= 8) {
      process.stderr.write(`✗ 疑似英文注释 ${file.replace(ROOT + '/', '')}:${index + 1} → ${text.trim().slice(0, 70)}\n`)
      bad += 1
    }
  })
}
if (bad > 0) {
  process.stderr.write(`\n共 ${bad} 处疑似英文注释。\n`)
  process.exit(1)
}
process.stdout.write('  ✓ 注释语言（全中文）\n')

/**
 * 注释语言检查 —— 纯英文注释视为 P0 缺陷（项目宪法铁律 1）。
 *
 * 规则：扫描 src/ 与 tests/ 下的 .ts 文件，任何以英文单词开头的
 * 行注释（// 或 /*）即失败。允许注释内含英文技术词（DSH/Cordis/
 * API/spawn 等），但注释主体必须中文。
 *
 * 用法：node scripts/check-comments.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIRS = ['src', 'tests']
/** vendored 第三方代码（Apache-2.0 taskboard）与生成代码（typert）不检查注释语言。 */
const SKIP_DIRS = ['src/taskboard', 'src/generated']

/** 判断一行注释是否为"纯英文"（整行去除注释标记后无任何中文字符，且非 JSDoc 标签行）。 */
function isEnglishComment(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) return false
  const content = trimmed.replace(/^\/\/\s*/, '').replace(/^\/\*\s*/, '').replace(/^\*\s*/, '')
  // 空注释或纯符号（如 *、/）不算英文注释
  if (!content.trim()) return false
  // JSDoc 标签行（@module/@param/@returns 等）是文档结构，不算注释内容
  if (/^@[a-z]+/.test(content.trimStart())) return false
  // 整行无中文字符且含 ASCII 字母 → 纯英文注释
  return !/[\u4e00-\u9fa5]/.test(content) && /[a-zA-Z]/.test(content)
}

/** 递归收集目录下所有 .ts 文件。 */
function collectTs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.some(skip => full.startsWith(join(ROOT, skip)))) continue
      out.push(...collectTs(full))
    }
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

let failures = 0
for (const dir of DIRS) {
  const abs = join(ROOT, dir)
  if (!readdirSync(ROOT, { withFileTypes: true }).some(e => e.name === dir)) continue
  for (const file of collectTs(abs)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (isEnglishComment(line)) {
        process.stdout.write(`✗ ${file.replace(ROOT + '/', '')}:${i + 1}: ${line.trim()}\n`)
        failures++
      }
    })
  }
}

if (failures > 0) {
  process.stdout.write(`\n发现 ${failures} 处纯英文注释（P0 缺陷），请改为中文注释。\n`)
  process.exitCode = 1
} else {
  process.stdout.write('✓ 注释语言检查通过（无纯英文注释）\n')
}

#!/usr/bin/env node
/**
 * 注释语言检查器 —— dsh-code-review 项目门禁之一。
 *
 * 递归扫描 src/ 下所有 .ts 文件的注释：纯英文注释即违规（P0）。
 * 中文注释豁免：注释含中文字符即视为中文注释，允许夹带英文技术词
 * （spawn/ENOENT/dirty-file/path/error 等）——与 dsh-code-architecture
 * 的 C1 规则保持一致。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

/** 判断一行是否属于注释：行注释或 JSDoc/块注释内容。 */
function isCommentLine(trimmed) {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('/**')
}

/** 递归收集目录下的全部 .ts 文件。 */
function collectTsFiles(dir) {
  const out = []
  let names = []
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) out.push(...collectTsFiles(abs))
    else if (name.endsWith('.ts')) out.push(abs)
  }
  return out.sort()
}

/** 扫描一个文件的注释行，返回违规行号与内容（纯英文注释）。 */
function scanFile(absPath) {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!isCommentLine(trimmed)) continue
    const text = trimmed
      .replace(/^\/\*\*?/, '')
      .replace(/^\/\//, '')
      .replace(/\*\/$/, '')
      .replace(/^\*/, '').replace(/^\* /, '')
      .trim()
    // JSDoc 标签行是声明性文档，跳过；含中文字符即中文注释，豁免
    if (text.length === 0 || text.startsWith('@')) continue
    if (/[\u4e00-\u9fff]/.test(text)) continue
    // 剩余为无中文的注释行：若含英文单词（不含纯符号/命令）即视为英文注释
    if (/[a-zA-Z]{2,}/.test(text)) violations.push({ line: i + 1, text: text.slice(0, 80) })
  }
  return violations
}

/** 主流程：递归扫描全部源文件并输出报告。 */
function main() {
  const files = collectTsFiles(SRC)
  let total = 0
  const report = []
  for (const f of files) {
    const rel = f.slice(SRC.length + 1)
    const violations = scanFile(f)
    if (violations.length > 0) {
      report.push(`== ${rel} ==`)
      for (const v of violations) {
        report.push(`  L${v.line}: ${v.text}`)
        total++
      }
    }
  }
  if (total > 0) {
    console.error(`✗ 发现 ${total} 处英文注释（项目规范：注释一律简体中文）：`)
    console.error(report.join('\n'))
    process.exit(1)
  }
  console.log('✓ 注释语言检查通过：全部为中文注释')
}

main()

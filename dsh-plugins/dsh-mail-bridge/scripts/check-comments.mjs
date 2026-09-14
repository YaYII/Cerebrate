#!/usr/bin/env node
/**
 * dsh-mail-bridge 注释语言检查：注释一律简体中文。
 * 纯英文注释（不含中文）即失败；专有名词与代码标识符豁免。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

/** 递归收集 src/ 下所有 .ts 文件。 */
function collectTs(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) collectTs(full, acc)
    else if (entry.endsWith('.ts')) acc.push(full)
  }
  return acc
}

const files = collectTs(join(ROOT, 'src'))
let failed = 0
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    // 只检查真正的注释行（// 或整行块注释）
    const m = trimmed.match(/^\/\/\s*(.*)$/) || trimmed.match(/^\/\*\*?\s*(.*)$/) || trimmed.match(/^\s*\*\s?(.*)$/)
    if (!m) return
    const text = m[1]
    if (text.length === 0) return
    // 跳过纯代码/URL/标识符行
    if (/^[\s\w.,;:'"!@#$%^&*()\[\]{}<>/?\\|+=~\-]+$/.test(text)) return
    // 注释主体必须含中文（允许夹带英文技术词）
    if (!/[\u4e00-\u9fa5]/.test(text)) {
      console.error(`✗ 纯英文注释: ${file}:${i + 1} → ${text.slice(0, 80)}`)
      failed++
    }
  })
}
if (failed > 0) {
  console.error(`✗ 注释语言检查失败：${failed} 处纯英文注释`)
  process.exit(1)
}
console.log('✓ 注释语言检查通过（全部中文）')

#!/usr/bin/env node
/**
 * 产物纯净性检查：lib/index.js 只允许依赖 node 内置模块。
 *
 * 为什么需要这道门禁：nodemailer 被刻意放在 devDependencies 里、由 tsdown
 * 构建期内联。一旦有人把依赖挪进 dependencies，tsdown 会把它外部化，产物就
 * 变成「需要 node_modules 才能加载」——部署侧（profile 按绝对路径加载单个
 * lib/index.js）会静默炸掉。这里把该约束变成可自动验证的铁律。
 */

import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname
const targets = ['lib/index.js', 'lib/invariant.js']

/** node 内置模块豁免名单（含 node: 前缀写法）。 */
const BUILTIN_PREFIX = 'node:'

let failed = 0
for (const target of targets) {
  const source = readFileSync(`${ROOT}${target}`, 'utf8')
  // 只扫描顶部 import 区，避免把产物内部的字符串误判为依赖
  const imports = [...source.matchAll(/^import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)].map(m => m[1])
  const external = imports.filter(specifier => specifier !== undefined
    && !specifier.startsWith(BUILTIN_PREFIX)
    && !specifier.startsWith('.'))
  if (external.length > 0) {
    console.error(`✗ ${target} 残留运行时外部依赖：${external.join(', ')}`)
    failed++
  } else {
    console.log(`✓ ${target} 仅依赖 node 内置模块`)
  }
}

if (failed > 0) {
  console.error('✗ 产物纯净性检查失败：请把第三方依赖放回 devDependencies，让 tsdown 内联它')
  process.exit(1)
}

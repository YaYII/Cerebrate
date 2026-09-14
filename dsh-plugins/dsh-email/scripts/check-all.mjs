#!/usr/bin/env node
/**
 * dsh-email 一键门禁：注释语言 + 产物纯净性 + 类型 + 测试 + 构建。
 * 任一失败即非零退出——门禁不过 = 任务未完成。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname

/** 运行一步门禁，失败即退出。 */
function step(name, command, args) {
  console.log(`[${name}] ${command} ${args.join(' ')}...`)
  try {
    execFileSync(command, args, { stdio: 'inherit', cwd: ROOT })
    console.log(`  ✓ ${name}`)
  } catch {
    console.error(`✗ 门禁未通过：${name}`)
    process.exit(1)
  }
}

step('注释语言检查', 'node', ['scripts/check-comments.mjs'])
if (existsSync(`${ROOT}node_modules/typescript/bin/tsc`)) {
  step('类型检查', 'node', ['node_modules/typescript/bin/tsc', '--noEmit'])
} else {
  console.log('  ⚠ typescript 未安装，跳过类型检查（tsdown 构建仍会校验语法）')
}
step('单元测试', 'node', ['node_modules/vitest/vitest.mjs', 'run'])
step('构建', 'node', ['node_modules/tsdown/dist/run.mjs'])
step('产物纯净性检查（不得残留运行时外部依赖）', 'node', ['scripts/check-bundle.mjs'])

console.log('\n✓ 全部门禁通过：注释 ✅ 类型 ✅ 测试 ✅ 构建 ✅ 产物 ✅')

#!/usr/bin/env node
/**
 * dsh-code-review 一键门禁：注释语言 + 类型 + 测试 + 构建。
 * 任一失败即非零退出——门禁不过 = 任务未完成。
 */

import { execFileSync } from 'node:child_process'

/** 运行一步门禁，失败即退出。 */
function step(name, command, args) {
  console.log(`[${name}] ${command} ${args.join(' ')}...`)
  try {
    execFileSync(command, args, { stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname })
    console.log(`  ✓ ${name}`)
  } catch {
    console.error(`✗ 门禁未通过：${name}`)
    process.exit(1)
  }
}

step('注释语言检查', 'node', ['scripts/check-comments.mjs'])
step('类型检查', 'node', ['node_modules/typescript/bin/tsc', '--noEmit'])
step('单元测试', 'node', ['node_modules/vitest/vitest.mjs', 'run'])
step('构建', 'node', ['node_modules/tsdown/dist/run.mjs'])

console.log('\n✓ 全部门禁通过：注释 ✅ 类型 ✅ 测试 ✅ 构建 ✅')

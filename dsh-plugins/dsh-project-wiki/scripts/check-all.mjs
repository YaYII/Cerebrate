#!/usr/bin/env node
/**
 * 统一门禁：注释语言 → 类型检查 → 单元测试 → 构建。
 *
 * 项目宪法 §8 的自动执行入口。任一步失败即非零退出；全部通过输出绿勾。
 * 用法：node scripts/check-all.mjs（或 pnpm check）
 */

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 运行一条命令并报告结果；失败时打印输出并返回 false。 */
function run(step, cmd, args) {
  process.stdout.write(`[${step}] ${cmd} ${args.join(' ')}...\n`)
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (res.status !== 0) {
    process.stderr.write((res.stdout || '') + (res.stderr || ''))
    process.stderr.write(`\n✗ 门禁未通过：${step}\n`)
    return false
  }
  process.stdout.write(`  ✓ ${step}\n`)
  return true
}

/** 主流程：按序执行四道门禁，全部通过才算完成。 */
function main() {
  const steps = [
    ['注释语言检查', 'node', ['scripts/check-comments.mjs']],
    ['类型检查', 'node', ['node_modules/typescript/bin/tsc', '--noEmit']],
    ['单元测试', 'node', ['node_modules/vitest/vitest.mjs', 'run']],
    ['构建', 'node', ['node_modules/tsdown/dist/run.mjs']],
  ]
  for (const [name, cmd, args] of steps) {
    if (!run(name, cmd, args)) process.exit(1)
  }
  process.stdout.write('\n✓ 全部门禁通过：注释 ✅ 类型 ✅ 测试 ✅ 构建 ✅\n')
}

main()

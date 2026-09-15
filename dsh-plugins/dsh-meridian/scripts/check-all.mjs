#!/usr/bin/env node
/**
 * 统一门禁：注释语言 → 类型检查 → 单元测试。
 *
 * 与同仓其它插件不同的一点：本插件**零本地依赖**（离线可用），
 * 工具链优先取本地 node_modules，取不到则回退到 DSH 检出（可用 DSH_TOOLCHAIN 覆盖）。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLCHAIN = process.env.DSH_TOOLCHAIN ?? '/home/as-workstation01/Documents/project/deepseek-harness/node_modules'

/** 解析可执行文件路径：先本地，再工具链。 */
function resolve(bin) {
  const local = join(ROOT, 'node_modules', '.bin', bin)
  if (existsSync(local)) return local
  return join(TOOLCHAIN, '.bin', bin)
}

/** 依次执行门禁步骤，任一失败即退出非零。 */
function main() {
  const steps = [
    ['注释语言检查', 'node', [join(ROOT, 'scripts', 'check-comments.mjs')]],
    ['类型检查', resolve('tsc'), ['--noEmit']],
    ['单元测试', 'node', ['--import', 'tsx', '--test', 'tests/ingest.spec.ts']],
  ]
  for (const [name, cmd, args] of steps) {
    process.stdout.write(`[${name}] ${cmd}\n`)
    const result = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    if (result.status !== 0) {
      process.stderr.write((result.stdout ?? '') + (result.stderr ?? ''))
      process.stderr.write(`\n✗ 门禁未通过：${name}\n`)
      process.exit(1)
    }
    if (name === '注释语言检查') process.stdout.write(result.stdout)
    else process.stdout.write(`  ✓ ${name}\n`)
  }
  process.stdout.write('\n✓ 全部门禁通过：注释 ✅ 类型 ✅ 测试 ✅\n')
}
main()

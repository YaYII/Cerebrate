/**
 * 一键门禁 —— 注释语言 + 类型 + 测试 + 构建。
 *
 * 用法：node scripts/check-all.mjs
 * 任一步失败即非零退出（门禁不过 = 任务未完成）。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 运行一步门禁，返回是否通过。 */
function runStep(name, command, args) {
  process.stdout.write(`\n=== ${name} ===\n`)
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  const ok = result.status === 0
  if (!ok) process.stdout.write(`\n✗ ${name} 失败（退出码 ${result.status}）\n`)
  else process.stdout.write(`✓ ${name} 通过\n`)
  return ok
}

/** Client bundle 的注册 id 必须等于 package.json name（client-modules 契约）。 */
function checkClientBundleId() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const escapedName = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const registered = new RegExp(`__ModuleLoader__\\.load\\(\\{\\s*id:\\s*["']${escapedName}["']`).test(bundle)
  process.stdout.write(`\n=== Client bundle 注册 id ===\n${registered ? '✓' : '✗'} ${registered ? '通过' : `失败（期望 ${pkg.name}）`}\n`)
  return registered
}

const steps = [
  ['注释语言检查', 'node', ['scripts/check-comments.mjs']],
  ['类型检查（host）', 'node', [join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']],
  ['类型检查（client）', 'node', [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.client.json', '--noEmit']],
  ['单元测试', 'node', [join('node_modules', 'vitest', 'vitest.mjs'), 'run']],
  ['构建 taskboard-host（tsc 转装饰器）', 'node', [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.tb-host.json']],
  ['构建（host）', 'node', [join('node_modules', 'tsdown', 'dist', 'run.mjs')]],
  ['构建（client）', 'node', [join('node_modules', 'tsdown', 'dist', 'run.mjs'), '-c', 'tsdown.client.config.ts']],
]

let allOk = true
for (const [name, cmd, args] of steps) {
  if (!runStep(name, cmd, args)) allOk = false
}
if (!checkClientBundleId()) allOk = false

if (allOk) {
  process.stdout.write('\n✅ 全部门禁通过\n')
} else {
  process.stdout.write('\n❌ 门禁未通过，请先修复再继续\n')
  process.exitCode = 1
}

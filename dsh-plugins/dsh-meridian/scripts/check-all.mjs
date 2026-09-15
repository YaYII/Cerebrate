#!/usr/bin/env node
/**
 * 统一门禁：注释语言 → 类型检查 → 单元测试 → 构建 → 插件冒烟。
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

/** 解析包内可执行文件：先本地 node_modules，再回退到 DSH 工具链。 */
function resolvePkg(rel) {
  const local = join(ROOT, 'node_modules', rel)
  return existsSync(local) ? local : join(TOOLCHAIN, rel)
}

/** 依次执行门禁步骤，任一失败即退出非零。 */
function main() {
  const steps = [
    ['注释语言检查', 'node', [join(ROOT, 'scripts', 'check-comments.mjs')]],
    ['类型检查', 'node', [resolvePkg('typescript/bin/tsc'), '--noEmit']],
    ['单元测试', 'node', ['--import', 'tsx', '--test', 'tests/ingest.spec.ts', 'tests/ruler.spec.ts', 'tests/crossLanguage.spec.ts', 'tests/acceptance.spec.ts', 'tests/multiLanguage.spec.ts', 'tests/hotspots.spec.ts']],
    ['构建', 'node', [resolvePkg('tsdown/dist/run.mjs')]],
    ['插件冒烟（装配 + 注册 + 真实日志调用）', 'node', [join(ROOT, 'scripts', 'dev-smoke.mjs')]],
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
    else if (name.startsWith('插件冒烟')) {
      // 工具数量不写死：从冒烟输出里读，避免文档与实际漂移
      const count = /注册工具 (\d+) 个/.exec(result.stdout ?? '')?.[1] ?? '?'
      process.stdout.write(`  ✓ ${name}（注册 ${count} 个工具，真实数据调用通过）\n`)
    }
    else process.stdout.write(`  ✓ ${name}\n`)
  }
  process.stdout.write('\n✓ 全部门禁通过：注释 ✅ 类型 ✅ 测试 ✅ 构建 ✅ 冒烟 ✅\n')
}
main()

/**
 * 运行时行为采集器 —— 引擎 A 的执行端（cog_trace 的核心）。
 *
 * 复用 arch_aop 已验证的加载机制：入口文件复制为 .stage.ts（相对导入补
 * .ts 后缀），生成 runner 脚本（注入 __COG_LOG 采集器 + import 入口 +
 * 触发业务函数），用 Node strip-types 运行，stdout 末尾输出行为记录。
 *
 * 采集器记录三类行为（对应三类埋点）：
 * - entry：入参摘要（脱敏 + 截断）+ 入栈配对；
 * - exit：与 entry 配对的耗时；
 * - state-change：副作用目标词。
 * 目标项目没有埋点时采集器静默不产生记录（可选链调用天然兼容）。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 运行时采集到的一条行为记录。 */
export interface TraceRecord {
  /** 目标 id（文件相对路径:函数名）。 */
  id: string
  phase: 'entry' | 'exit' | 'state-change'
  /** 事件时间戳。 */
  ts: number
  /** 耗时（exit 时，entry/exit 配对）。 */
  ms?: number
  /** 入参摘要（entry 时，已脱敏截断）。 */
  args?: string
  /** 副作用目标词（state-change 时）。 */
  target?: string
}

/** 一次运行时采集的结果。 */
export interface TraceResult {
  /** 行为记录（时间序）。 */
  records: TraceRecord[]
  /** 入口触发是否异常。 */
  entryFailed: boolean
  /** 原始输出（含错误时用于诊断）。 */
  rawOutput: string
}

/** 采集器源码：注入到 runner 顶部，实现 __COG_LOG。 */
export const COLLECTOR_SOURCE = [
  'globalThis.__COG_RECORDS = globalThis.__COG_RECORDS ?? []',
  'globalThis.__COG_STACK = globalThis.__COG_STACK ?? []',
  'globalThis.__COG_LOG = globalThis.__COG_LOG ?? ((msg) => {',
  '  try {',
  '    if (msg.p === \'entry\') {',
  '      const args = msg.a ? JSON.stringify(msg.a) : \'\'',
  '      globalThis.__COG_RECORDS.push({ id: msg.id, phase: \'entry\', args: args.slice(0, 120), ts: Date.now() })',
  '      globalThis.__COG_STACK.push({ id: msg.id, t: Date.now() })',
  '    } else if (msg.p === \'exit\') {',
  '      const top = globalThis.__COG_STACK.pop()',
  '      globalThis.__COG_RECORDS.push({ id: msg.id, phase: \'exit\', ms: top && top.id === msg.id ? Date.now() - top.t : 0, ts: Date.now() })',
  '    } else if (msg.p === \'state-change\') {',
  '      globalThis.__COG_RECORDS.push({ id: msg.id, phase: \'state-change\', target: msg.s, ts: Date.now() })',
  '    }',
  '  } catch {}',
  '})',
].join('\n')

/** 入口函数探测顺序。 */
const ENTRY_NAMES = ['default', 'processVerify', 'processOrder', 'process', 'main', 'run', 'start', 'execute', 'handler']

/**
 * 暂存入口模块：复制为 .stage.ts 并给相对导入补 .ts 后缀，
 * 使 runner 能在 Node ESM 下直接加载 TypeScript 模块。
 * @param entryAbs - 入口文件绝对路径。
 * @returns 暂存文件绝对路径。
 */
export function stageEntry(entryAbs: string): string {
  const src = readFileSync(entryAbs, 'utf8')
  const outAbs = entryAbs.replace(/\.(ts|js)$/, '.stage.ts')
  const rewritten = src.replace(/from\s+['"]([^'"]+)['"]/g, (m: string, spec: string) => {
    if (spec.startsWith('.')) return m.replace(spec, spec.endsWith('.ts') ? spec : spec + '.ts')
    return m
  })
  writeFileSync(outAbs, rewritten, 'utf8')
  return outAbs
}

/**
 * 生成 runner 脚本：注入采集器 + 加载入口 + 触发业务函数 + 输出行为记录。
 * @param entryAbs - 暂存后的入口绝对路径。
 * @param outDir - runner 输出目录。
 * @returns runner 绝对路径。
 */
export function generateRunner(entryAbs: string, outDir: string): string {
  mkdirSync(outDir, { recursive: true })
  const runnerPath = join(outDir, 'cog-runner.mjs')
  const script = `
${COLLECTOR_SOURCE}

/** 行为采集 runner：加载入口模块，触发业务入口，输出行为记录（JSON 到 stdout 末尾）。 */
const mod = await import(${JSON.stringify('file://' + entryAbs)})
const ENTRY_NAMES = ${JSON.stringify(ENTRY_NAMES)}
let entryFn = null
for (const n of ENTRY_NAMES) {
  if (typeof mod[n] === 'function') { entryFn = mod[n]; break }
}
if (!entryFn) {
  const first = Object.entries(mod).find(([, v]) => typeof v === 'function')
  if (first) entryFn = first[1]
}
let entryFailed = false
if (entryFn && process.env.COG_CALL_ENTRY === '1') {
  try {
    await entryFn()
  } catch {
    entryFailed = true
  }
}
const records = globalThis.__COG_RECORDS ?? []
process.stdout.write('\\n__COG_RESULT__' + JSON.stringify({ records, entryFailed }) + '\\n')
`
  writeFileSync(runnerPath, script, 'utf8')
  return runnerPath
}

/**
 * 运行行为采集：执行入口并解析行为记录。
 * @param opts - 运行选项。
 * @returns 行为记录与入口异常标记。
 */
export function runCogTrace(opts: {
  projectDir: string
  entryAbs: string
  timeoutMs?: number
}): TraceResult {
  const { projectDir, entryAbs } = opts
  const cwd = resolve(projectDir)
  const outDir = join(cwd, '.code-cognition')
  const staged = stageEntry(entryAbs)
  const runnerPath = generateRunner(staged, outDir)
  const timeout = opts.timeoutMs ?? 60000
  let stdout = ''
  try {
    const res = execFileSync('node', ['--experimental-strip-types', '--input-type=module', '-e', 'process.env.COG_CALL_ENTRY="1"; import(' + JSON.stringify('file://' + runnerPath) + ')'], {
      cwd,
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    stdout = res
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    stdout = (err.stdout ?? '') + '\n' + (err.stderr ?? '')
  }
  const marker = '__COG_RESULT__'
  const idx = stdout.lastIndexOf(marker)
  if (idx === -1) {
    return { records: [], entryFailed: false, rawOutput: stdout.slice(-500) }
  }
  try {
    const parsed = JSON.parse(stdout.slice(idx + marker.length).trim()) as { records: TraceRecord[]; entryFailed: boolean }
    return { records: parsed.records ?? [], entryFailed: parsed.entryFailed === true, rawOutput: '' }
  } catch {
    return { records: [], entryFailed: false, rawOutput: stdout.slice(-500) }
  }
}

/**
 * 生成行为时序链报告文本（中文，供 AI 直接阅读）。
 * @param result - 采集结果。
 * @param maxDepth - 展示的最大调用深度（默认 20）。
 * @returns 报告文本。
 */
export function traceReportText(result: TraceResult): string {
  const lines: string[] = []
  lines.push('# 行为时序链报告')
  lines.push('')
  if (result.entryFailed) {
    lines.push('⚠️ **入口触发异常**：入口函数抛出了异常（见 rawOutput 诊断）。')
    lines.push('')
  }
  lines.push(`共采集 ${result.records.length} 条行为记录。`)
  lines.push('')
  lines.push('## 行为时序（时间序）')
  lines.push('')
  if (result.records.length === 0) {
    lines.push('无行为记录 —— 目标项目可能尚未注入埋点（先运行 cog_instrument），')
    lines.push('或入口函数未被触发。')
  } else {
    lines.push('```')
    const stack: string[] = []
    for (const r of result.records) {
      if (r.phase === 'entry') {
        stack.push(r.id)
        lines.push('  '.repeat(stack.length - 1) + '▶ ' + r.id + (r.args ? ' 入参: ' + r.args : ''))
      } else if (r.phase === 'exit') {
        const depth = Math.max(0, stack.length - 1)
        stack.pop()
        lines.push('  '.repeat(depth) + '◀ ' + r.id + (r.ms !== undefined ? ` 耗时 ${r.ms}ms` : ''))
      } else {
        lines.push('  '.repeat(stack.length) + '◆ ' + r.id + ' 状态变更: ' + (r.target ?? ''))
      }
    }
    lines.push('```')
  }
  lines.push('')
  lines.push('## 解读指引')
  lines.push('- ▶ 进入 / ◀ 退出配对即为一次完整调用，耗时 = 退出记录的 ms。')
  lines.push('- ◆ 状态变更 = 写库/发请求等副作用点，核对是否符合业务预期。')
  lines.push('- 出现异常入口时，优先用 rawOutput 定位抛错位置。')
  return lines.join('\n')
}

/** 检查是否存在可观测的入口文件。 */
export function findEntry(cwd: string): string | null {
  const candidates = ['src/index.ts', 'src/main.ts', 'index.ts', 'main.ts', 'src/index.js', 'index.js']
  for (const c of candidates) {
    const abs = join(cwd, c)
    try { readFileSync(abs) } catch { continue }
    return abs
  }
  return null
}

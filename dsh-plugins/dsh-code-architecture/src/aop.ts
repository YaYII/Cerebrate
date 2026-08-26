/**
 * AOP 执行观测器：在目标项目入口注入探针，追踪函数调用链与耗时。
 *
 * 目标：让 AI 获得「业务流转的实测证据」——哪个函数被调用、耗时多少、
 * 调用链如何展开，从而定位瓶颈与异常点，而不是靠猜。
 *
 * 实现：为 JS/TS 项目生成一个探针包装器（wrapper），用 Proxy/包装函数
 * 包裹模块导出，运行目标脚本后输出调用树与耗时统计。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { instrumentFile } from './instrument'

/** 一次调用的观测记录。 */
export interface CallRecord {
  /** 函数全名（模块名.函数名）。 */
  name: string
  /** 调用序号（时间序）。 */
  seq: number
  /** 本次调用耗时（毫秒）。 */
  ms: number
  /** 开始时间戳。 */
  start: number
  /** 是否抛出异常。 */
  threw: boolean
  /** 调用深度（嵌套层级）。 */
  depth: number
}

/** AOP 观测结果。 */
export interface AopResult {
  /** 全部调用记录（时间序）。 */
  calls: CallRecord[]
  /** 按函数聚合：次数 / 总耗时 / 平均耗时 / 最大耗时。 */
  hotspots: Array<{ name: string; count: number; totalMs: number; avgMs: number; maxMs: number }>
  /** 是否观测到异常。 */
  threw: boolean
}

/**
 * 生成探针脚本：包裹目标入口模块的导出函数，记录调用与耗时。
 * 返回探针脚本绝对路径。
 */
/**
 * 暂存入口模块：复制为 .mjs 并给相对导入补 .ts 后缀，
 * 使探针能在 Node ESM 下直接加载 TypeScript 模块。
 */
function stageEntry(entryAbs: string, outDir: string): string {
  const src = readFileSync(entryAbs, 'utf8')
  const outAbs = entryAbs.replace(/.ts$/, '.stage.ts')
  // 给相对导入补 .ts 后缀（Node ESM + strip-types 需要显式扩展名）
  const rewritten = src.replace(/from\s+['"]([^'"]+)['"]/g, (m: string, spec: string) => {
    if (spec.startsWith('.')) {
      return m.replace(spec, spec.endsWith('.ts') ? spec : spec + '.ts')
    }
    return m
  })
  writeFileSync(outAbs, rewritten, 'utf8')
  return outAbs
}
export function generateProbe(entryAbs: string, outDir: string): string {
  // 源码级插桩：包裹每个具名函数，观测模块内部调用链
  entryAbs = instrumentFile(entryAbs)


  mkdirSync(outDir, { recursive: true })
  const probePath = join(outDir, 'aop-probe.mjs')
  const script = `
/** AOP 探针：包裹入口模块导出，输出调用树与耗时（JSON 到 stdout 末尾）。 */
const records = []
let seq = 0
let depth = 0
const wrap = (ns, prefix) => {
  const out = {}
  for (const [k, v] of Object.entries(ns)) {
    if (typeof v === 'function') {
      out[k] = async (...args) => {
        const start = Date.now()
        depth++
        const mySeq = ++seq
        let threw = false
        try {
          return await v.apply(ns, args)
        } catch (e) {
          threw = true
          throw e
        } finally {
          records.push({ name: prefix + k, seq: mySeq, ms: Date.now() - start, start, threw, depth })
          depth--
        }
      }
    } else {
      out[k] = v
    }
  }
  return out
}
const mod = await import(${JSON.stringify('file://' + entryAbs)})
const wrapped = wrap(mod.default ?? mod, '')
// 递归包裹 import 的子模块导出，实现跨模块调用链观测（业务层 → 功能层砖块）
const subWrapped = {}
for (const [k, v] of Object.entries(mod)) {
  if (k !== 'default' && typeof v === 'object' && v !== null) subWrapped[k] = wrap(v, k + '.')
}
// 触发入口：优先 default 函数；否则尝试具名业务入口（processOrder/process/main/run/start/execute）
const ENTRY_NAMES = ['default', 'processVerify', 'processOrder', 'process', 'main', 'run', 'start', 'execute', 'handler']
let entryFn = null
for (const n of ENTRY_NAMES) {
  if (typeof wrapped[n] === 'function') { entryFn = wrapped[n]; break }
}
// 兜底：未命中预设入口时，取第一个导出函数作为入口
if (!entryFn) {
  const first = Object.entries(wrapped).find(([, v]) => typeof v === 'function')
  if (first) entryFn = first[1]
}
if (entryFn && process.env.AOP_CALL_ENTRY === '1') {
  try {
    // 入口可能声明参数：用空字符串/数字演示参数触发，让业务流转真实跑起来
    await entryFn('demo-qr', 'demo-sign', 0)
  } catch (e) {
    records.push({ name: 'ENTRY_CALL_FAILED', seq: ++seq, ms: 0, start: Date.now(), threw: true, depth: 0 })
  }
}
const internal = globalThis.__AOP_RECORDS ?? []
records.push(...internal.map((r, i) => ({ name: r.name, seq: records.length + i + 1, ms: r.ms, start: 0, threw: false, depth: r.depth + 1 })))
process.stdout.write('\\n__AOP_RESULT__' + JSON.stringify(records) + '\\n')
`
  writeFileSync(probePath, script, 'utf8')
  return probePath
}

/**
 * 运行探针：执行目标入口（若为 CLI 脚本则直接跑，若是模块则调用导出入口），
 * 解析调用记录并聚合热点。
 */
export function runAopProbe(opts: {
  entryAbs: string
  cwd: string
  timeoutMs?: number
}): AopResult {
  const { entryAbs, cwd } = opts
  const outDir = join(cwd, '.code-arch')
  const probePath = generateProbe(entryAbs, outDir)
  const timeout = opts.timeoutMs ?? 60000
  let stdout = ''
  try {
    const res = execFileSync('node', ['--experimental-strip-types', '--input-type=module', '-e', 'process.env.AOP_CALL_ENTRY="1"; import(' + JSON.stringify('file://' + probePath) + ')'], {
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
  // 解析 __AOP_RESULT__ 标记后的 JSON
  const marker = '__AOP_RESULT__'
  const idx = stdout.lastIndexOf(marker)
  if (idx === -1) {
    return { calls: [], hotspots: [], threw: false }
  }
  const json = stdout.slice(idx + marker.length).trim()
  const calls = JSON.parse(json) as CallRecord[]
  const byName = new Map<string, { count: number; totalMs: number; maxMs: number }>()
  let threw = false
  for (const c of calls) {
    if (c.threw) threw = true
    const cur = byName.get(c.name) ?? { count: 0, totalMs: 0, maxMs: 0 }
    cur.count++
    cur.totalMs += c.ms
    cur.maxMs = Math.max(cur.maxMs, c.ms)
    byName.set(c.name, cur)
  }
  const hotspots = [...byName.entries()]
    .map(([name, v]) => ({ name, count: v.count, totalMs: Math.round(v.totalMs), avgMs: Math.round(v.totalMs / v.count), maxMs: Math.round(v.maxMs) }))
    .sort((a, b) => b.totalMs - a.totalMs)
  return { calls, hotspots, threw }
}

/** 生成 AOP 分析报告文本（中文，供 AI 直接阅读）。 */
export function aopReportText(result: AopResult): string {
  const lines: string[] = []
  lines.push('# AOP 执行观测报告')
  lines.push('')
  lines.push('共观测 ' + result.calls.length + ' 次函数调用' + (result.threw ? '，**存在异常抛出**' : '，无异常') + '。')
  lines.push('')
  lines.push('## 耗时热点 Top10（总耗时降序）')
  lines.push('')
  lines.push('| 函数 | 调用次数 | 总耗时(ms) | 平均(ms) | 最大(ms) |')
  lines.push('|---|---|---|---|---|')
  for (const h of result.hotspots.slice(0, 10)) {
    lines.push(`| ${h.name} | ${h.count} | ${h.totalMs} | ${h.avgMs} | ${h.maxMs} |`)
  }
  lines.push('')
  lines.push('## 调用链（最深 5 条）')
  lines.push('')
  lines.push('```')
  const chain: string[] = []
  for (const c of result.calls.slice(0, 60)) {
    chain.push('  '.repeat(c.depth) + c.name + ' ' + c.ms + 'ms' + (c.threw ? ' ⚠️异常' : ''))
  }
  lines.push(chain.join('\n'))
  lines.push('```')
  lines.push('')
  lines.push('## 解读指引')
  lines.push('- 总耗时最高的函数 = 可能的瓶颈；平均耗时高 + 调用频繁 = 热点路径。')
  lines.push('- 出现 ⚠️异常 的位置 = 业务流转与预期不符的点，优先排查。')
  lines.push('- 调用链中深度嵌套的节点 = 关注拆分与缓存机会。')
  return lines.join('\n')
}

/** 检查是否存在可观测的入口文件。 */
export function findEntry(cwd: string): string | null {
  const candidates = ['src/index.ts', 'src/main.ts', 'index.ts', 'main.ts', 'src/index.js', 'index.js']
  for (const c of candidates) {
    if (existsSync(join(cwd, c))) return join(cwd, c)
  }
  return null
}

/**
 * 性能工具：程序级基准与函数级 CPU 剖析。
 *
 * - `runBench` 运行一条命令 N 次，报告 p50/p90/均值/最小/最大以及内存峰值
 *   RSS——回答「这个程序运行消耗多少性能」。
 * - `runProfile` 驱动语言的剖析器（JS/TS 用 v8 `--cpu-prof`，Python 用
 *   `cProfile`；Java/PHP 注册了 JFR/Xdebug 模板并以 pending 报告）并把产物
 *   解析为 Top-N 热点函数列表——性能 bug 的直接证据。
 * @module @deepseek-ai/dsh-code-review
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { runCommand, quantile } from './runner'
import { resolveBin, type Toolchain } from './languages'
import type { BenchResult, BenchSample, ProfileEntry, ProfileResult } from './types'

/** {@link runBench} 的选项。 */
export interface BenchOptions {
  /** 待基准的完整命令行，如 `node dist/index.js --quick`。 */
  command: string
  cwd?: string
  iterations?: number
  timeoutMs?: number
}

/** {@link runProfile} 的选项。 */
export interface ProfileOptions {
  /** 待剖析的命令（不含剖析器包装），如 `dist/index.js --quick`。 */
  command: string
  cwd?: string
  toolchain: Toolchain
  timeoutMs?: number
}

/**
 * 反复运行一条命令并聚合时序。首次运行标记为冷启动，不参与聚合，避免
 * JIT/模块加载预热扭曲数字。
 * @param options - 基准选项。
 * @returns 聚合结果。
 */
export async function runBench(options: BenchOptions): Promise<BenchResult> {
  const iterations = Math.max(2, options.iterations ?? 5)
  const parts = splitCommand(options.command)
  const samples: BenchSample[] = []
  let peakRssMb: number | undefined
  let error: string | undefined

  for (let i = 0; i < iterations; i++) {
    const result = await runCommand(parts[0] ?? options.command, parts.slice(1), {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      timeoutMs: options.timeoutMs ?? 120_000,
    })
    const coldStart = i === 0
    samples.push({ run: i + 1, durationMs: result.durationMs, ...(coldStart ? { coldStart: true } : {}) })
    if (result.peakRssMb !== undefined && (peakRssMb === undefined || result.peakRssMb > peakRssMb)) {
      peakRssMb = result.peakRssMb
    }
    if (result.exitCode !== 0 && error === undefined) {
      error = `run ${i + 1} exited ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}: ${result.stderr.slice(0, 300)}`
    }
  }

  const steady = samples.filter(sample => !sample.coldStart).map(sample => sample.durationMs)
  const sorted = [...steady].sort((a, b) => a - b)
  return {
    command: options.command,
    cwd: options.cwd ?? process.cwd(),
    iterations,
    samples,
    meanMs: steady.length > 0 ? Math.round(steady.reduce((sum, ms) => sum + ms, 0) / steady.length) : 0,
    p50Ms: Math.round(quantile(sorted, 0.5)),
    p90Ms: Math.round(quantile(sorted, 0.9)),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    ...(peakRssMb !== undefined ? { peakRssMb: Math.round(peakRssMb * 10) / 10 } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

/**
 * 用工具链的剖析器剖析一条命令并返回热点函数。
 * @param options - 剖析选项。
 * @returns 剖析结果（解析器未接入时引擎为 `pending`）。
 */
export async function runProfile(options: ProfileOptions): Promise<ProfileResult> {
  const profileDir = join(os.tmpdir(), `dsh-code-review-${process.pid}-${Date.now()}`)
  mkdirSync(profileDir, { recursive: true })
  const parts = splitCommand(options.command)
  const profile = options.toolchain.profile

  try {
    if (profile.engine === 'v8-cpuprofile') {
      return await profileWithV8(options, profileDir, parts)
    }
    if (profile.engine === 'cprofile') {
      return await profileWithCProfile(options, profileDir, parts)
    }
    return {
      engine: 'pending',
      totalMs: 0,
      entries: [],
      note: `${options.toolchain.language} profiler (${profile.engine}) template registered — artifact parser not wired yet`,
    }
  } finally {
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      // 尽力清理。
    }
  }
}

async function profileWithV8(
  options: ProfileOptions,
  profileDir: string,
  targetParts: string[],
): Promise<ProfileResult> {
  // 命令形态：node --cpu-prof --cpu-prof-dir=<目录> --cpu-prof-name=out.cpuprofile <目标...>（产物落在剖析目录）
  const profileArgs = [
    '--cpu-prof',
    `--cpu-prof-dir=${profileDir}`,
    '--cpu-prof-name=out.cpuprofile',
    ...targetParts,
  ]
  const nodeBin = options.cwd ? resolveBin(options.cwd, 'node') : 'node'
  const result = await runCommand(nodeBin, profileArgs, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    timeoutMs: options.timeoutMs ?? 120_000,
  })
  const artifact = join(profileDir, 'out.cpuprofile')
  let raw: string
  try {
    raw = readFileSync(artifact, 'utf8')
  } catch {
    return {
      engine: 'v8-cpuprofile',
      totalMs: 0,
      entries: [],
      note: `profiler produced no artifact (exit ${result.exitCode}, timedOut=${result.timedOut}): ${result.stderr.slice(0, 300)}`,
    }
  }
  const entries = parseV8CpuProfile(raw)
  return {
    engine: 'v8-cpuprofile',
    totalMs: entries.reduce((sum, entry) => sum + entry.selfMs, 0),
    entries,
    note: `profiled ${options.command} via node --cpu-prof`,
  }
}

async function profileWithCProfile(
  options: ProfileOptions,
  profileDir: string,
  targetParts: string[],
): Promise<ProfileResult> {
  const artifact = join(profileDir, 'out.prof')
  // python3 -m cProfile -o out.prof <target...>  →  再用 pstats 渲染。
  const pythonBin = options.cwd ? resolveBin(options.cwd, 'python3') : 'python3'
  const run = await runCommand(pythonBin, ['-m', 'cProfile', '-o', artifact, ...targetParts], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    timeoutMs: options.timeoutMs ?? 120_000,
  })
  if (run.exitCode !== 0) {
    return {
      engine: 'cprofile',
      totalMs: 0,
      entries: [],
      note: `profiled command failed (exit ${run.exitCode}): ${run.stderr.slice(0, 300)}`,
    }
  }
  const render = await runCommand(
    pythonBin,
    ['-c', `import pstats; pstats.Stats('${artifact}').sort_stats('cumulative').print_stats(25)`],
    { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), timeoutMs: 30_000 },
  )
  const entries = parseCProfileText(render.stdout)
  return {
    engine: 'cprofile',
    totalMs: entries.reduce((sum, entry) => sum + entry.selfMs, 0),
    entries,
    note: `profiled ${options.command} via python3 -m cProfile`,
  }
}

/**
 * 把 v8 `.cpuprofile` JSON 解析为按自耗时排序的热点函数。
 * 聚合键是 `url:line:functionName`，同一帧的样本合并为一条。
 */
export function parseV8CpuProfile(raw: string): ProfileEntry[] {
  let profile: {
    nodes?: Array<{
      id: number
      callFrame: { functionName?: string; url?: string; lineNumber?: number }
      children?: number[]
      hitCount?: number
    }>
    samples?: number[]
    timeDeltas?: number[]
  }
  try {
    profile = JSON.parse(raw)
  } catch {
    return []
  }
  const nodeById = new Map<number, { functionName: string; url: string; line: number }>()
  for (const node of profile.nodes ?? []) {
    nodeById.set(node.id, {
      functionName: node.callFrame?.functionName || '(anonymous)',
      url: node.callFrame?.url || '(native)',
      line: (node.callFrame?.lineNumber ?? 0) + 1,
    })
  }
  // 按节点 id 聚合（每个调用帧唯一）——样本直接引用节点 id，
  // 无需字符串键的往返转换。
  const selfNs = new Map<number, number>()
  const samples = profile.samples ?? []
  const timeDeltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i]
    if (nodeId === undefined || !nodeById.has(nodeId)) continue
    const deltaNs = (timeDeltas[i] ?? 0) * 1000
    selfNs.set(nodeId, (selfNs.get(nodeId) ?? 0) + deltaNs)
  }

  const entries: ProfileEntry[] = [...selfNs.entries()]
    .map(([nodeId, self]) => {
      const frame = nodeById.get(nodeId)!
      // v8 cpuprofile 节点不带父指针，不重建栈就无法推导总耗时；
      // 因此 total 按 self 报告。
      return {
        functionName: frame.functionName,
        url: frame.url,
        line: frame.line,
        selfMs: self / 1e6,
        selfPct: 0,
        totalMs: self / 1e6,
        totalPct: 0,
        calls: 1,
      }
    })
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 10)
  const totalSelfMs = entries.reduce((sum, entry) => sum + entry.selfMs, 0)
  for (const entry of entries) {
    entry.selfPct = totalSelfMs > 0 ? Math.round((entry.selfMs / totalSelfMs) * 1000) / 10 : 0
    entry.totalPct = entry.selfPct
  }
  return entries
}

/**
 * 解析 `pstats` 文本输出：`ncalls  tottime  percall  cumtime  percall  filename:lineno(function)`。
 * 尽力而为；畸形行跳过。
 */
export function parseCProfileText(output: string): ProfileEntry[] {
  const entries: ProfileEntry[] = []
  const lines = output.split('\n')
  for (const line of lines) {
    const match = /^\s*([\d.]+)\s+([\d.]+)\s+[\d.]+\s+([\d.]+)\s+[\d.]+\s+(.+)$/.exec(line)
    if (!match) continue
    const location = match[4] ?? ''
    const paren = location.lastIndexOf('(')
    if (paren === -1) continue
    const fileLine = location.slice(0, paren)
    const functionName = location.slice(paren + 1, -1)
    const colon = fileLine.lastIndexOf(':')
    const file = colon === -1 ? fileLine : fileLine.slice(0, colon)
    const lineNo = colon === -1 ? 0 : Number(fileLine.slice(colon + 1)) || 0
    entries.push({
      functionName,
      url: file,
      line: lineNo,
      selfMs: Number(match[2]) * 1000,
      selfPct: 0,
      totalMs: Number(match[3]) * 1000,
      totalPct: 0,
      calls: Number(match[1]) || 0,
    })
  }
  // 按最大总耗时归一化百分比。
  const maxTotal = entries.reduce((max, entry) => Math.max(max, entry.totalMs), 0)
  for (const entry of entries) {
    entry.selfPct = entry.totalMs > 0 ? Math.round((entry.selfMs / entry.totalMs) * 1000) / 10 : 0
    entry.totalPct = maxTotal > 0 ? Math.round((entry.totalMs / maxTotal) * 1000) / 10 : 0
  }
  return entries.slice(0, 10)
}

/** 把命令行字符串拆为 [exe, ...args]，尊重简单引号。 */
export function splitCommand(line: string): string[] {
  const parts: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of line.matchAll(re)) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return parts
}

/** 把结果产物持久化到审查目录下。 */
export function saveArtifact(projectDir: string, artifactsDir: string, name: string, value: unknown): string {
  const dir = join(projectDir, artifactsDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

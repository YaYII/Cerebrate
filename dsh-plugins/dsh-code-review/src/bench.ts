/**
 * Performance tooling: program-level benchmarking and function-level CPU
 * profiling.
 *
 * - `runBench` runs a command N times and reports p50/p90/mean/min/max plus
 *   peak RSS — this answers "how much does this program cost to run".
 * - `runProfile` drives the language's profiler (v8 `--cpu-prof` for
 *   JS/TS, `cProfile` for Python; JFR/Xdebug templates are registered for
 *   Java/PHP and reported as pending) and parses the artifact into a Top-N
 *   hot-function list — this is where performance bugs surface.
 * @module @deepseek-ai/dsh-code-review
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { runCommand, quantile } from './runner'
import { resolveBin, type Toolchain } from './languages'
import type { BenchResult, BenchSample, ProfileEntry, ProfileResult } from './types'

/** Options for {@link runBench}. */
export interface BenchOptions {
  /** Full command line to benchmark, e.g. `node dist/index.js --quick`. */
  command: string
  cwd?: string
  iterations?: number
  timeoutMs?: number
}

/** Options for {@link runProfile}. */
export interface ProfileOptions {
  /** Command to profile (without the profiler wrapper), e.g. `dist/index.js --quick`. */
  command: string
  cwd?: string
  toolchain: Toolchain
  timeoutMs?: number
}

/**
 * Run a command repeatedly and aggregate timings. The first run is tagged as
 * the cold start and excluded from aggregates so JIT/module-load warm-up does
 * not distort the numbers.
 * @param options - bench options.
 * @returns aggregated result.
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
 * Profile a command with the toolchain's profiler and return hot functions.
 * @param options - profile options.
 * @returns profile result (engine `pending` when the parser is not wired).
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
      // Best effort cleanup.
    }
  }
}

async function profileWithV8(
  options: ProfileOptions,
  profileDir: string,
  targetParts: string[],
): Promise<ProfileResult> {
  // node --cpu-prof --cpu-prof-dir=<dir> --cpu-prof-name=out.cpuprofile <target...>
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
  // python3 -m cProfile -o out.prof <target...>  →  then render with pstats.
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
 * Parse a v8 `.cpuprofile` JSON into hot functions ranked by self time.
 * Aggregation key is `url:line:functionName` so samples from the same frame
 * collapse into one entry.
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
  // Aggregate by node id (unique per call frame) — samples reference node ids
  // directly, so no string-key round-trip is needed.
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
      // v8 cpuprofile nodes carry no parent pointers, so total time cannot be
      // derived without reconstructing stacks; total is reported as self.
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
 * Parse `pstats` text output: `ncalls  tottime  percall  cumtime  percall  filename:lineno(function)`.
 * Best-effort; malformed lines are skipped.
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
  // Normalize percentages against the largest total time.
  const maxTotal = entries.reduce((max, entry) => Math.max(max, entry.totalMs), 0)
  for (const entry of entries) {
    entry.selfPct = entry.totalMs > 0 ? Math.round((entry.selfMs / entry.totalMs) * 1000) / 10 : 0
    entry.totalPct = maxTotal > 0 ? Math.round((entry.totalMs / maxTotal) * 1000) / 10 : 0
  }
  return entries.slice(0, 10)
}

/** Split a command-line string into [exe, ...args] honoring simple quotes. */
export function splitCommand(line: string): string[] {
  const parts: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of line.matchAll(re)) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return parts
}

/** Persist a result artifact under the review directory. */
export function saveArtifact(projectDir: string, artifactsDir: string, name: string, value: unknown): string {
  const dir = join(projectDir, artifactsDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

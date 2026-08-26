/**
 * Subprocess runner shared by every code-review tool.
 *
 * All spawned commands get a hard timeout, bounded stdout/stderr capture
 * (head+tail, so a runaway log cannot blow up the agent context) and — on
 * Linux — a peak-RSS measurement via /proc polling.
 * @module @deepseek-ai/dsh-code-review
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Options for {@link runCommand}. */
export interface RunOptions {
  cwd?: string
  /** Hard kill after this many ms. Default 60 000. */
  timeoutMs?: number
  /** Maximum captured bytes per stream; the middle is elided. Default 64 KiB. */
  maxOutputBytes?: number
  env?: Record<string, string>
}

/** Result of one subprocess run. */
export interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  /** Peak resident set size in MB (Linux); undefined elsewhere or when the process died too fast. */
  peakRssMb?: number
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT = 64 * 1024

/** Capture a stream with head+tail elision. A null stream (failed spawn) is an empty capture. */
function capture(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return Promise.resolve({ text: '', truncated: false })
  const head: Buffer[] = []
  const tail: Buffer[] = []
  let headLen = 0
  let tailLen = 0
  let sawOverflow = false
  return new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      const len = chunk.length
      if (headLen + len <= maxBytes) {
        head.push(chunk)
        headLen += len
      } else {
        // Keep the tail for the error frame; drop the middle.
        sawOverflow = true
        const remaining = maxBytes - tailLen
        if (remaining > 0) {
          const slice = len > remaining ? chunk.subarray(len - remaining) : chunk
          tail.push(slice)
          tailLen += slice.length
          if (tailLen > maxBytes) tail.shift()
        }
      }
    })
    stream.on('error', reject)
    stream.on('close', () => {
      let text = ''
      if (headLen > 0 || tailLen > 0) {
        const body = sawOverflow ? Buffer.concat([...head, Buffer.from('\n…<truncated>…\n'), ...tail]) : Buffer.concat(head)
        text = body.toString('utf8')
      }
      resolve({ text, truncated: sawOverflow })
    })
  })
}

/**
 * Run one command to completion with timeout, output bounding and RSS
 * measurement. Never throws for a non-zero exit: the caller inspects
 * `exitCode` / `stderr`.
 * @param command - executable (may be an absolute path).
 * @param args - arguments.
 * @param options - run options.
 * @returns the captured result.
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const started = performance.now()
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let peakRssMb: number | undefined
  let timedOut = false
  let killed = false
  const rssTimer = setInterval(() => {
    if (child.pid === undefined) return
    try {
      const status = readFileSync(`/proc/${child.pid}/status`, 'utf8')
      const match = /^VmHWM:\s+(\d+) kB$/m.exec(status)
      if (match) {
        const mb = Number(match[1]) / 1024
        if (peakRssMb === undefined || mb > peakRssMb) peakRssMb = mb
      }
    } catch {
      // Process already gone or non-Linux: measurement unavailable.
    }
  }, 100)

  // Exit-code settlement state, declared before the timer so the timeout
  // safety net can reach it; listeners attach immediately after.
  let spawnError: string | undefined
  let settled = false
  let settleExit: (code: number | null) => void = () => {}

  const timer = setTimeout(() => {
    timedOut = true
    killed = true
    child.kill('SIGKILL')
    // Safety net: never leave the exit promise pending, even if the kill
    // races the stream events.
    if (!settled) {
      settled = true
      settleExit(null)
    }
  }, timeoutMs)

  // Register the exit-code listeners BEFORE awaiting captures: a failed spawn
  // (ENOENT) emits 'error' early, and with no listener attached that error
  // becomes an uncaught exception. 'close' always follows 'error' (code -2),
  // but both are guarded by `settled`.
  const exitCodeP = new Promise<number | null>(resolve => {
    settleExit = resolve
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = `${error.code ?? 'spawn'}: ${error.message}`
      if (!settled) {
        settled = true
        resolve(killed ? null : -1)
      }
    })
    child.on('close', code => {
      if (!settled) {
        settled = true
        resolve(code)
      }
    })
  })

  const [stdoutP, stderrP] = await Promise.all([
    capture(child.stdout, maxBytes),
    capture(child.stderr, maxBytes),
  ])
  const exitCode = await exitCodeP

  clearTimeout(timer)
  clearInterval(rssTimer)

  return {
    exitCode,
    stdout: stdoutP.text,
    stderr: `${stderrP.text}${spawnError !== undefined ? `\n${spawnError}` : ''}`,
    durationMs: Math.round(performance.now() - started),
    ...(peakRssMb !== undefined ? { peakRssMb } : {}),
    timedOut,
  }
}

/**
 * Compute the p-quantile of a sorted numeric array (linear interpolation,
 * R type 7 — the common default, e.g. NumPy `quantile`).
 */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo] ?? 0
  const lower = sorted[lo] ?? 0
  const upper = sorted[hi] ?? lower
  return lower + (idx - lo) * (upper - lower)
}

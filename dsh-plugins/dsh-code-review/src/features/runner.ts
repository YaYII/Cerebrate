/**
 * 所有 code-review 工具共享的子进程运行器。
 *
 * 每个被 spawn 的命令都有硬超时、有界的 stdout/stderr 捕获（保留头尾、
 * 丢弃中间，防止失控日志撑爆 agent 上下文），并在 Linux 上通过 /proc
 * 轮询测量内存峰值 RSS。
 * @module @deepseek-ai/dsh-code-review
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** {@link runCommand} 的选项。 */
export interface RunOptions {
  cwd?: string
  /** 超过此时长强杀进程。默认 60 000ms。 */
  timeoutMs?: number
  /** 每个流的最大捕获字节数；中间部分省略。默认 64 KiB。 */
  maxOutputBytes?: number
  env?: Record<string, string>
}

/** 一次子进程运行的结果。 */
export interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  /** 内存峰值 RSS（MB，Linux）；其他平台或进程过早死亡时无。 */
  peakRssMb?: number
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT = 64 * 1024

/** 捕获一个流（头尾省略式）。null 流（spawn 失败）为空捕获。 */
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
        // 溢出：保留尾部用于错误帧，丢弃中间。
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
 * 运行一条命令直到结束，带超时、输出有界与 RSS 测量。非零退出不抛错：
 * 调用方检查 `exitCode` / `stderr`。
 * @param command - 可执行文件（可以是绝对路径）。
 * @param args - 参数。
 * @param options - 运行选项。
 * @returns 捕获的结果。
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
      // 进程已退出或非 Linux：测量不可用。
    }
  }, 100)

  // 退出码结算状态：先声明，让超时安全网可以够到；监听器立即挂接。
  let spawnError: string | undefined
  let settled = false
  let settleExit: (code: number | null) => void = () => {}

  const timer = setTimeout(() => {
    timedOut = true
    killed = true
    child.kill('SIGKILL')
    // 安全网：即使 kill 与流事件竞争，也绝不让退出 promise 悬挂。
    if (!settled) {
      settled = true
      settleExit(null)
    }
  }, timeoutMs)

  // 在等待捕获之前注册退出码监听：失败的 spawn（ENOENT）会提前触发 'error'，
  // 此时若无监听器就会变成未捕获异常。'close' 总是跟随 'error'（code -2），
  // 但两者都被 `settled` 保护。
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
 * 计算有序数组的 p 分位数（线性插值，R 类型 7——常见默认，
 * 如 NumPy `quantile`）。
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

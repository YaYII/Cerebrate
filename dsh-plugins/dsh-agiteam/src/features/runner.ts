/**
 * 验收测试执行器 —— 在指定目录运行测试命令（单测/API/脚本/E2E）。
 *
 * 为什么独立成砖块：环境敏感逻辑（spawn/路径/超时）集中在这里，
 * 业务层只需描述"跑什么命令、在哪个目录"，即可获得有界输出与退出码。
 *
 * 验收模式：
 *  - unit   运行单元测试（如 `npm test`）
 *  - api    模拟用户请求（如 `curl`/`httpx`/自研脚本）
 *  - script 运行自动化脚本（如 `node scripts/e2e.mjs`）
 *  - e2e    端到端场景脚本
 */

import { spawn } from 'node:child_process'

/** {@link runAcceptanceCommand} 的选项。 */
export interface RunAcceptanceOptions {
  /** 工作目录。 */
  cwd: string
  /** 超时毫秒数（默认 120 秒）。 */
  timeoutMs?: number
  /** 单条输出最大捕获字节（默认 64 KiB）。 */
  maxOutputBytes?: number
}

/** 一次验收命令的运行结果。 */
export interface AcceptanceRunResult {
  /** 退出码（null=被超时强杀）。 */
  exitCode: number | null
  /** 标准输出（有界）。 */
  stdout: string
  /** 标准错误（有界）。 */
  stderr: string
  /** 耗时毫秒。 */
  durationMs: number
  /** 是否超时。 */
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT = 64 * 1024

/** 有界捕获一个流（头尾保留、中间截断）。 */
function captureStream(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
): Promise<string> {
  if (stream === null) return Promise.resolve('')
  const head: Buffer[] = []
  const tail: Buffer[] = []
  let headLen = 0
  let tailLen = 0
  let sawOverflow = false
  return new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      const len = chunk.length
      if (headLen + len <= maxBytes) {
        head.push(chunk)
        headLen += len
      } else {
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
        const body = sawOverflow
          ? Buffer.concat([...head, Buffer.from('\n…<truncated>…\n'), ...tail])
          : Buffer.concat(head)
        text = body.toString('utf8')
      }
      resolve(text)
    })
  })
}

/**
 * 运行一条验收命令直到结束（带超时与有界输出）。非零退出不抛错，
 * 由调用方检查 exitCode / stderr 判定成败。
 */
export async function runAcceptanceCommand(
  command: string,
  args: string[],
  options: RunAcceptanceOptions,
): Promise<AcceptanceRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const started = performance.now()
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let timedOut = false
  let killed = false
  let spawnError: string | undefined
  let settled = false
  let settleExit: (code: number | null) => void = () => {}

  const timer = setTimeout(() => {
    timedOut = true
    killed = true
    child.kill('SIGKILL')
    if (!settled) {
      settled = true
      settleExit(null)
    }
  }, timeoutMs)

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

  const [stdout, stderr] = await Promise.all([
    captureStream(child.stdout, maxBytes),
    captureStream(child.stderr, maxBytes),
  ])
  const exitCode = await exitCodeP
  clearTimeout(timer)

  return {
    exitCode,
    stdout,
    stderr: `${stderr}${spawnError !== undefined ? `\n${spawnError}` : ''}`,
    durationMs: Math.round(performance.now() - started),
    timedOut,
  }
}

/**
 * Qoder CLI 执行器 —— 以非交互模式（-p/--print）运行 qodercli 完成一次任务。
 *
 * 为什么独立成砖块：Qoder 是外部 CLI 智能体，通过子进程调用，
 * 环境敏感逻辑（spawn/超时/有界输出）集中在这里，业务层只描述
 * "让 Qoder 在哪个目录做什么"。
 *
 * 调用形态（已实测可用）：
 *   qodercli -p --permission-mode bypass_permissions --cwd <dir> "<任务指令>"
 */

import { spawn } from 'node:child_process'

/** {@link runQoderTask} 的选项。 */
export interface QoderRunOptions {
  /** 工作目录。 */
  cwd: string
  /** 超时毫秒数（Qoder 是完整 agent，任务可能较长，默认 10 分钟）。 */
  timeoutMs?: number
  /** 单条输出最大捕获字节（默认 128 KiB）。 */
  maxOutputBytes?: number
  /** 指定模型（如 Qwen3.8-Max）；缺省用 Qoder 默认模型。 */
  model?: string
}

/** 一次 Qoder 任务的结果。 */
export interface QoderRunResult {
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

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT = 128 * 1024

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
 * 运行一次 Qoder 非交互任务直到结束（带超时与有界输出）。
 * 非零退出不抛错，由调用方检查 exitCode / stderr 判定成败。
 * @param task 任务指令（完整 prompt，Qoder 将按它执行）
 * @param options 工作目录/超时/模型等
 */
export async function runQoderTask(
  task: string,
  options: QoderRunOptions,
): Promise<QoderRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const started = performance.now()

  // qodercli 参数：-p 非交互输出、bypass 权限、cwd、可选模型
  const args = ['-p', '--permission-mode', 'bypass_permissions']
  if (options.model) args.push('--model', options.model)
  args.push('--cwd', options.cwd, task)

  const child = spawn('qodercli', args, {
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

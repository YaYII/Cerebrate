/**
 * Qoder 角色指挥 —— 把 Qoder CLI 作为 agiteam 可指挥的外部角色。
 *
 * 业务编排：校验项目存在 → 用 Qoder 非交互模式执行任务（工作目录=项目 cwd）
 * → 记录审计（action=qoder-task）→ 返回执行结果与输出摘要。
 *
 * 使用场景：让 Qoder（独立 CLI 智能体，带自己的模型/skill/工具面）
 * 承担项目内某类任务（如代码审查、测试编写、文档生成），
 * 与 agiteam 内置角色（dsh 子 agent）互补。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgiteamConfig } from './engine'
import type { ToolResult } from './tools'
import { runQoderTask } from '../features/qoder-runner'

/** 工具参数（与装配层 schema 一致）。 */
export interface QoderTaskArgs {
  /** 项目 id（任务工作目录 = 项目 cwd）。 */
  projectId: string
  /** 任务指令（完整 prompt，Qoder 按它执行）。 */
  task: string
  /** 可选：指定 Qoder 模型（如 Qwen3.8-Max）；缺省用 Qoder 默认模型。 */
  model?: string
  /** 可选：覆盖工作目录（默认项目 cwd）。 */
  cwd?: string
  /** 可选：超时毫秒（默认 600000 = 10 分钟）。 */
  timeoutMs?: number
}

/**
 * 指挥 Qoder CLI 执行一次任务。
 * @param ctx 插件上下文
 * @param config 插件配置
 * @param args 任务参数
 * @returns 执行结果（含 Qoder 输出摘要与审计 seq）
 */
export async function executeQoderTask(
  ctx: Context,
  config: AgiteamConfig,
  args: QoderTaskArgs,
): Promise<ToolResult> {
  // 校验项目存在（DB 优先，回退旧 engine）
  let projectCwd = args.cwd
  try {
    const { openAgiteamDomain, getProject } = await import('./store')
    const domain = await openAgiteamDomain(ctx)
    const project = getProject(domain, args.projectId)
    if (project && project.cwd) projectCwd = project.cwd
  } catch { /* DB 不可用时用 args.cwd 或进程 cwd */ }

  const cwd = projectCwd ?? process.cwd()
  if (!args.task || args.task.trim().length === 0) {
    return { status: 'error', message: 'task 必填（Qoder 要执行的任务指令）' }
  }

  // 执行 Qoder 非交互任务（可选参数仅在非空时传，满足 exactOptionalPropertyTypes）
  const run = await runQoderTask(args.task, {
    cwd,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
  })

  // 记录审计（qoder-task + 退出码指纹）
  let seq: number | undefined
  let hash: string | undefined
  try {
    const { openAgiteamDomain, appendAuditRecord, lastAudit } = await import('./store')
    const { makeAuditEntry } = await import('../features/audit')
    const domain = await openAgiteamDomain(ctx)
    const prev = lastAudit(domain, args.projectId)
    const entry = makeAuditEntry(prev ? prev.seq + 1 : 1, {
      time: Date.now(),
      action: 'qoder-task',
      role: 'qoder',
      projectId: args.projectId,
      stage: '',
      detail: JSON.stringify({
        task: args.task.slice(0, 200),
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
      }),
      fingerprint: run.exitCode === 0 ? run.stdout.slice(0, 64) : run.stderr.slice(0, 64),
    }, prev ? prev.hash : 'GENESIS')
    await appendAuditRecord(domain, entry)
    seq = entry.seq
    hash = entry.hash
  } catch { /* 审计失败不阻断结果返回 */ }

  const passed = run.exitCode === 0 && !run.timedOut
  const output = (passed ? run.stdout : run.stderr).trim()
  return {
    status: passed ? 'ok' : 'error',
    message: `Qoder 任务${passed ? '完成' : `失败（退出码 ${run.exitCode}${run.timedOut ? '，超时' : ''}）`}，耗时 ${(run.durationMs / 1000).toFixed(1)}s。`,
    projectId: args.projectId,
    passed,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    outputTail: output.slice(-4000),
    ...(seq !== undefined && hash !== undefined ? { seq, hash } : {}),
  }
}

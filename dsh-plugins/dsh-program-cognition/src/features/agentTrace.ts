/**
 * Agent 行为采集器 —— 引擎 B：会话级 Tracing（cog_agent 的数据源）。
 *
 * 零侵入监听 DSH 原生事件（agent/* + session/event），把 AI 自身行为
 * 聚合为 AgentBehaviorRecord 流：统一关联键 sessionId:turn:step:callId
 * 全链路贯通；幽灵路径三源识别（interrupted / pre-step reject / inbox
 * discarded）；工具调用按 callId 配对计算耗时。行为记录落盘
 * agent-behaviors.ndjson（决策 #7：项目内 .code-cognition/）。
 *
 * 本文件是纯数据聚合砖块：不直接注册事件监听（由 index.ts 装配层
 * 把事件转发进来），保证可独立测试。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { summarize } from './redact'

/** AI 行为类型（对齐设计稿 §3.5 事件映射表）。 */
export type AgentBehaviorKind =
  | 'lifecycle' | 'status' | 'inbox' | 'step-proposal' | 'input' | 'output'
  | 'tool-call' | 'tool-result' | 'step-end' | 'request-error' | 'plan'

/** 一条 AI 自身行为记录。 */
export interface AgentBehaviorRecord {
  /** 统一关联键：sessionId:turn:step。 */
  key: string
  sessionId: string
  turn: number
  step: number
  /** 工具调用配对键（tool-call/tool-result）。 */
  callId?: string
  kind: AgentBehaviorKind
  /** 事件时间戳（毫秒）。 */
  ts: number
  /** 行为摘要（脱敏后）。 */
  summary: string
  /** 工具名。 */
  toolName?: string
  /** 是否异常（tool-result error / request-error / interrupted）。 */
  failed: boolean
  /** 耗时（工具调用起止）。 */
  durationMs?: number
  /** 细节（脱敏后，如 token usage）。 */
  detail?: Record<string, unknown>
}

/** 引擎 B 采集配置。 */
export interface AgentTraceConfig {
  /** 默认 true：记录 tool/call 的 arguments 与 tool/result 的 message 摘要。 */
  captureToolArgs: boolean
  /** 环形缓冲上限（每条会话）。 */
  bufferLimit: number
  /** 采样率 0-1。 */
  sampleRate: number
}

/** 默认采集配置（决策 #6：默认详细，redact 兜底）。 */
export const DEFAULT_AGENT_TRACE_CONFIG: AgentTraceConfig = {
  captureToolArgs: true,
  bufferLimit: 2000,
  sampleRate: 1,
}

/** 行为缓冲（按会话管理）。 */
export class AgentTraceBuffer {
  private records: AgentBehaviorRecord[] = []
  private toolCalls = new Map<string, { ts: number; name: string }>()

  /** 构造行为缓冲。 */
  constructor(private config: AgentTraceConfig = DEFAULT_AGENT_TRACE_CONFIG) {}

  /**
   * 追加一条行为记录（带采样与缓冲上限控制）。
   * @param rec - 行为记录（key/ts 等由调用方填充）。
   */
  push(rec: AgentBehaviorRecord): void {
    if (Math.random() > this.config.sampleRate) return
    this.records.push(rec)
    if (this.records.length > this.config.bufferLimit) this.records.splice(0, this.records.length - this.config.bufferLimit)
  }

  /** 当前缓冲长度。 */
  get length(): number { return this.records.length }

  /** 读取全部记录（拷贝，防外部篡改）。 */
  all(): AgentBehaviorRecord[] { return [...this.records] }

  /** 清空缓冲。 */
  clear(): void { this.records = []; this.toolCalls.clear() }

  /**
   * 把缓冲 flush 到 ndjson 文件（追加模式，会话间共用同一文件）。
   * @param filePath - 落盘文件绝对路径。
   * @returns 本次写入的记录数。
   */
  flush(filePath: string): number {
    if (this.records.length === 0) return 0
    mkdirSync(dirname(filePath), { recursive: true })
    const lines = this.records.map(r => JSON.stringify(r)).join('\n') + '\n'
    appendFileSync(resolve(filePath), lines, 'utf8')
    const count = this.records.length
    this.clear()
    return count
  }

  /**
   * 记录工具调用（callId 登记，供 result 配对耗时）。
   * @param callId - 工具调用 id。
   * @param name - 工具名。
   * @param ts - 事件时间戳（毫秒）。
   */
  trackToolCall(callId: string, name: string, ts: number): void {
    this.toolCalls.set(callId, { ts, name })
  }

  /**
   * 取工具调用登记（result 配对耗时，配对后移除）。
   * @param callId - 工具调用 id。
   * @returns 登记信息（无登记返回 undefined）。
   */
  matchToolResult(callId: string): { ts: number; name: string } | undefined {
    const entry = this.toolCalls.get(callId)
    if (entry) this.toolCalls.delete(callId)
    return entry
  }
}

/** 简化的工具调用结果信息（从 session 事件中提取的最小形状）。 */
interface ToolCallInfo { callId: string; name: string; arguments: string }
interface ToolResultInfo { callId: string; ok: boolean; errorText?: string; message: string }

/**
 * 从 session 事件生成行为记录（事件转发入口，由装配层调用）。
 * @param buffer - 行为缓冲。
 * @param sessionId - 会话 id。
 * @param event - session 事件。
 * @param captureArgs - 是否记录工具参数详情。
 * @returns 是否产生了记录。
 */
export function recordFromSessionEvent(
  buffer: AgentTraceBuffer,
  sessionId: string,
  event: SessionEvent,
  captureArgs: boolean,
): boolean {
  const turn = 'turn' in event.data ? Number((event.data as { turn?: unknown }).turn ?? 0) : 0
  const step = 'step' in event.data ? Number((event.data as { step?: unknown }).step ?? 0) : 0
  const key = `${sessionId}:${turn}:${step}`
  const base = { sessionId, turn, step, key, ts: event.time }

  switch (event.type) {
    case 'user/message': {
      const data = event.data as { content?: unknown }
      buffer.push({
        ...base, kind: 'input', failed: false,
        summary: summarize(data.content, ['password', 'token', 'secret']),
      })
      return true
    }
    case 'assistant/message': {
      const data = event.data as { message?: { content?: unknown; reasoning?: unknown }; usage?: { input?: number; output?: number }; interrupted?: true }
      const text = typeof data.message?.content === 'string' ? data.message.content : ''
      const interrupted = data.interrupted === true
      buffer.push({
        ...base, kind: 'output', failed: interrupted,
        summary: summarize(text.slice(0, 200)),
        ...(data.usage !== undefined
          ? { detail: { input: data.usage.input ?? 0, output: data.usage.output ?? 0 } }
          : {}),
        ...(interrupted ? { detail: { interrupted: true } } : {}),
      })
      return true
    }
    case 'tool/call': {
      const data = event.data as unknown as ToolCallInfo
      buffer.trackToolCall(data.callId, data.name, event.time)
      buffer.push({
        ...base, kind: 'tool-call', failed: false, callId: data.callId, toolName: data.name,
        summary: captureArgs ? summarize(data.arguments) : `调用 ${data.name}`,
      })
      return true
    }
    case 'tool/result': {
      const data = event.data as unknown as ToolResultInfo & { error?: { name?: string; code?: string }; meta?: unknown }
      const started = buffer.matchToolResult(data.callId)
      const failed = data.ok === false || data.error !== undefined
      buffer.push({
        ...base, kind: 'tool-result', failed, callId: data.callId,
        ...started === undefined ? {} : { toolName: started.name },
        summary: failed
          ? `失败: ${data.errorText ?? data.error?.code ?? data.error?.name ?? '未知错误'}`
          : (captureArgs ? summarize(data.message) : '完成'),
        ...(started ? { durationMs: Math.max(0, event.time - started.ts) } : {}),
      })
      return true
    }
    case 'step/end': {
      buffer.push({ ...base, kind: 'step-end', failed: false, summary: `步骤 ${step} 结束` })
      return true
    }
    case 'todo/write': {
      const data = event.data as { todos?: Array<{ content?: string }> }
      const count = data.todos?.length ?? 0
      buffer.push({ ...base, kind: 'plan', failed: false, summary: `任务清单更新（${count} 项）` })
      return true
    }
    default:
      return false
  }
}

/**
 * 生成引擎 B 行为流报告文本（中文，供 AI 直接阅读）。
 * @param records - 行为记录。
 * @param sessionId - 查询的会话 id（用于标题）。
 * @returns 报告文本。
 */
export function agentReportText(records: AgentBehaviorRecord[], sessionId: string): string {
  const lines: string[] = []
  lines.push(`# Agent 行为分析（会话 ${sessionId}）`)
  lines.push('')
  if (records.length === 0) {
    lines.push('暂无行为记录 —— 引擎 B 正在监听本 DSH 进程的 agent 事件，')
    lines.push('产生行为后（本会话的任何工具调用/步骤），再次查询即可看到。')
    lines.push('')
    return lines.join('\n')
  }
  const toolCalls = records.filter(r => r.kind === 'tool-call')
  const failures = records.filter(r => r.failed)
  const ghost = records.filter(r => r.kind === 'inbox' || r.kind === 'step-proposal')
  const turns = new Set(records.map(r => r.turn)).size
  lines.push(`共 ${records.length} 条行为记录：${turns} 个 turn、${toolCalls.length} 次工具调用、${failures.length} 次异常。`)
  lines.push('')
  lines.push('## 行为流（时间序）')
  lines.push('')
  lines.push('```')
  for (const r of records.slice(-80)) {
    const mark = r.failed ? ' ⚠️' : ''
    lines.push(`t${r.turn}s${r.step} [${r.kind}] ${r.summary}${r.durationMs !== undefined ? ` (${r.durationMs}ms)` : ''}${mark}`)
  }
  lines.push('```')
  lines.push('')
  if (failures.length > 0) {
    lines.push('## 失败根源')
    lines.push('')
    for (const f of failures.slice(0, 10)) lines.push(`- t${f.turn}: ${f.summary}`)
    lines.push('')
  }
  if (ghost.length > 0) {
    lines.push('## 幽灵路径（被中断/被否决/被丢弃）')
    lines.push('')
    for (const g of ghost.slice(0, 10)) lines.push(`- t${g.turn}: ${g.summary}`)
    lines.push('')
  }
  lines.push('## 解读指引')
  lines.push('- ⚠️ 标记 = 异常/中断，优先核对失败根源。')
  lines.push('- 幽灵路径 = AI 尝试过但放弃的方向，洞察决策过程。')
  return lines.join('\n')
}

/** Session 类型引用（供装配层使用）。 */
export type { Session }

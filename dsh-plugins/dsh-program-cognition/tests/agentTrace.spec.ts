/**
 * Agent 行为采集器单元测试：会话事件转行为记录、工具调用配对、幽灵路径、缓冲落盘。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentTraceBuffer, recordFromSessionEvent, DEFAULT_AGENT_TRACE_CONFIG, registerTraceBuffer, unregisterTraceBuffer, peekTraceBuffer } from '../src/features/agentTrace'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 构造最小 session 事件。 */
function ev(type: string, data: Record<string, unknown>, time = 1000): SessionEvent {
  return { type, seq: 1, time, data } as unknown as SessionEvent
}

describe('agentTrace 引擎 B', () => {
  it('user/message 生成 input 记录', () => {
    const buffer = new AgentTraceBuffer()
    const ok = recordFromSessionEvent(buffer, 's1', ev('user/message', {
      turn: 1, step: 1,
      content: [{ type: 'text', text: '修复登录问题' }],
    }), true)
    expect(ok).toBe(true)
    const rec = buffer.all()[0]!
    expect(rec.kind).toBe('input')
    expect(rec.key).toBe('s1:1:1')
    expect(rec.summary).toContain('修复登录问题')
  })

  it('tool/call 与 tool/result 按 callId 配对并计算耗时', () => {
    const buffer = new AgentTraceBuffer()
    recordFromSessionEvent(buffer, 's1', ev('tool/call', {
      turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}',
    }), true)
    const call = buffer.all()[0]!
    expect(call.kind).toBe('tool-call')
    expect(call.toolName).toBe('bash')
    expect(call.summary).toContain('cmd')
    // 结果事件（时间推进模拟耗时）
    recordFromSessionEvent(buffer, 's1', ev('tool/result', {
      turn: 1, step: 2, callId: 'c1', message: 'done', ok: true,
    }, 1500), true)
    const result = buffer.all()[1]!
    expect(result.kind).toBe('tool-result')
    expect(result.durationMs).toBeGreaterThanOrEqual(499)
    expect(result.failed).toBe(false)
  })

  it('tool/result 带 error 标记失败并摘要错误', () => {
    const buffer = new AgentTraceBuffer()
    recordFromSessionEvent(buffer, 's1', ev('tool/call', {
      turn: 1, step: 1, callId: 'c2', name: 'curl', arguments: '{}',
    }), true)
    recordFromSessionEvent(buffer, 's1', ev('tool/result', {
      turn: 1, step: 1, callId: 'c2', message: '', error: { name: 'Error', code: 'ECONNREFUSED' },
    }), true)
    const result = buffer.all()[1]!
    expect(result.failed).toBe(true)
    expect(result.summary).toContain('ECONNREFUSED')
  })

  it('captureArgs=false 时工具参数摘要为纯调用', () => {
    const buffer = new AgentTraceBuffer({ ...DEFAULT_AGENT_TRACE_CONFIG, captureToolArgs: false })
    recordFromSessionEvent(buffer, 's1', ev('tool/call', {
      turn: 1, step: 1, callId: 'c3', name: 'bash', arguments: '{"cmd":"rm -rf /"}',
    }), false)
    const call = buffer.all()[0]!
    expect(call.summary).toBe('调用 bash')
    expect(call.summary).not.toContain('rm')
  })

  it('assistant/message 中断标记生成失败记录（幽灵路径）', () => {
    const buffer = new AgentTraceBuffer()
    recordFromSessionEvent(buffer, 's1', ev('assistant/message', {
      turn: 1, step: 1, message: { content: '正在分析…' }, interrupted: true,
    }), true)
    const rec = buffer.all()[0]!
    expect(rec.kind).toBe('output')
    expect(rec.failed).toBe(true)
  })

  it('step/end 与 todo/write 生成 step-end/plan 记录', () => {
    const buffer = new AgentTraceBuffer()
    recordFromSessionEvent(buffer, 's1', ev('step/end', { turn: 1, step: 1 }), true)
    recordFromSessionEvent(buffer, 's1', ev('todo/write', { turn: 1, step: 2, todos: [{ content: 'a' }, { content: 'b' }] }), true)
    expect(buffer.all()[0]!.kind).toBe('step-end')
    expect(buffer.all()[1]!.kind).toBe('plan')
    expect(buffer.all()[1]!.summary).toContain('2 项')
  })

  it('未知事件类型静默忽略', () => {
    const buffer = new AgentTraceBuffer()
    const ok = recordFromSessionEvent(buffer, 's1', ev('unknown/type', { x: 1 }), true)
    expect(ok).toBe(false)
    expect(buffer.length).toBe(0)
  })

  it('缓冲 flush 落盘 ndjson 并清空', () => {
    const buffer = new AgentTraceBuffer()
    recordFromSessionEvent(buffer, 's1', ev('user/message', { turn: 1, step: 1, content: 'hi' }), true)
    const file = join(tmpdir(), `cog-agent-${Date.now()}.ndjson`)
    const count = buffer.flush(file)
    expect(count).toBe(1)
    expect(buffer.length).toBe(0)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]!).sessionId).toBe('s1')
    rmSync(file, { force: true })
  })

  it('缓冲超限时截断最旧记录', () => {
    const buffer = new AgentTraceBuffer({ ...DEFAULT_AGENT_TRACE_CONFIG, bufferLimit: 3 })
    for (let i = 0; i < 6; i++) {
      recordFromSessionEvent(buffer, 's1', ev('step/end', { turn: 1, step: i }), true)
    }
    expect(buffer.length).toBe(3)
    expect(buffer.all()[0]!.step).toBe(3)
  })

  it('注册表：查询侧可读到活跃缓冲的未落盘记录', () => {
    const file = join(tmpdir(), `cog-reg-${Date.now()}.ndjson`)
    const buffer = new AgentTraceBuffer()
    registerTraceBuffer(file, buffer)
    try {
      recordFromSessionEvent(buffer, 's1', ev('tool/call', {
        turn: 1, step: 1, callId: 'c9', name: 'bash', arguments: '{}',
      }), true)
      // 未 flush 也能查到（合并内存记录）
      const mem = peekTraceBuffer(file)
      expect(mem.length).toBe(1)
      expect(mem[0]!.toolName).toBe('bash')
      // 未注册路径返回空
      expect(peekTraceBuffer(file + '.none')).toEqual([])
    } finally {
      unregisterTraceBuffer(file)
      rmSync(file, { force: true })
    }
  })
})

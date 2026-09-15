/**
 * completedTurnPrefixOf（执行 agent 继承主管会话上下文的种子提取）单元测试。
 */

import { describe, expect, it } from 'vitest'
import { completedTurnPrefixOf } from '../src/taskboard/execution/seed-prefix'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 构造最小合法会话事件（seq 与数组下标一致，追加契约）。 */
function event(seq: number, type: string): SessionEvent {
  return { seq, type, data: {} } as unknown as SessionEvent
}

/** 构造一个带 events 的假 Agent（仅暴露 session.events）。 */
function agentWith(events: SessionEvent[]) {
  return { session: { events } } as unknown as { session: { events: readonly SessionEvent[] } }
}

describe('completedTurnPrefixOf（主管上下文继承种子）', () => {
  it('无任何已完成回合（无 turn/end）时返回 undefined（保持无种子创建）', () => {
    const events = [
      event(0, 'session/created'),
      event(1, 'user/message'),
      event(2, 'turn/start'),
      // 无 turn/end：正在进行的回合
    ]
    expect(completedTurnPrefixOf(agentWith(events) as never)).toBeUndefined()
  })

  it('截到最后一个 turn/end（含），返回连续前缀', () => {
    const events = [
      event(0, 'session/created'),
      event(1, 'user/message'),
      event(2, 'turn/start'),
      event(3, 'assistant/message'),
      event(4, 'turn/end'),
      event(5, 'user/message'), // 下一回合开始（未结束）
      event(6, 'turn/start'),
    ]
    const prefix = completedTurnPrefixOf(agentWith(events) as never)
    expect(prefix).toBeDefined()
    expect(prefix?.length).toBe(5)
    expect(prefix?.at(4)?.type).toBe('turn/end')
    expect(prefix?.at(0)?.seq).toBe(0)
  })

  it('多回合时只取最后一个已结束回合（后续未结束回合被排除）', () => {
    const events = [
      event(0, 'turn/end'),
      event(1, 'turn/start'),
      event(2, 'assistant/message'),
      event(3, 'turn/end'),
      event(4, 'turn/start'),
    ]
    const prefix = completedTurnPrefixOf(agentWith(events) as never)
    expect(prefix?.length).toBe(4)
    expect(prefix?.at(3)?.type).toBe('turn/end')
  })
})

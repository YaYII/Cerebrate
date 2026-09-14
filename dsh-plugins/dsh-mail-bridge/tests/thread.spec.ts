/**
 * 线程砖块测试：会话标签的生成/提取、主题基归一化，以及四类路由判定。
 * 这是整个插件的路由大脑——「回复哪封邮件就唤醒哪个分身」全靠它。
 */
import { describe, expect, it } from 'vitest'
import {
  createThreadTag,
  extractThreadTag,
  replySubject,
  routeMessage,
  subjectBase,
} from '../src/features/thread'
import type { ThreadLookup } from '../src/features/thread'

/** 构造一个线程索引：已知标签 s7f3a，且知道某个 Message-ID 属于它。 */
function lookup(overrides: Partial<ThreadLookup> = {}): ThreadLookup {
  return {
    hasTag: tag => tag === 's7f3a',
    tagForMessageId: id => (id === '<tip@qq.com>' ? 's7f3a' : undefined),
    ...overrides,
  }
}

describe('会话标签', () => {
  it('从主题中提取标签并转小写', () => {
    expect(extractThreadTag('Re: 报价单 [#S7F3A]')).toBe('s7f3a')
    expect(extractThreadTag('没有标签的主题')).toBeUndefined()
  })

  it('生成的标签为 6 位且可复现（注入随机源）', () => {
    expect(createThreadTag(() => 0)).toBe('000000')
    expect(createThreadTag()).toHaveLength(6)
  })

  it('主题基去掉回复前缀与标签', () => {
    expect(subjectBase('Re: Fwd: 报价单 [#s7f3a]')).toBe('报价单')
    expect(subjectBase('回复：报价单 [#s7f3a]')).toBe('报价单')
  })

  it('回信主题同时带上 Re: 与标签（人类可见、机器可解析）', () => {
    expect(replySubject('报价单', 's7f3a')).toBe('Re: 报价单 [#s7f3a]')
    // 反复回复不会堆积 Re: 与标签
    expect(replySubject('Re: 报价单 [#s7f3a]', 's7f3a')).toBe('Re: 报价单 [#s7f3a]')
  })
})

describe('routeMessage 路由判定', () => {
  it('主题标签命中已知会话 → 线程路由（主路由）', () => {
    const decision = routeMessage(
      { from: 'owner@x.com', subject: 'Re: 报价单 [#s7f3a]', inReplyTo: undefined, references: [] },
      'owner',
      lookup(),
    )
    expect(decision.kind).toBe('thread')
    expect(decision.tag).toBe('s7f3a')
  })

  it('主题标签丢失但 In-Reply-To 命中 → 线程路由（兜底路由）', () => {
    const decision = routeMessage(
      { from: 'owner@x.com', subject: 'Re: 报价单', inReplyTo: '<tip@qq.com>', references: [] },
      'owner',
      lookup(),
    )
    expect(decision.kind).toBe('thread')
    expect(decision.tag).toBe('s7f3a')
  })

  it('References 链命中同样可路由', () => {
    const decision = routeMessage(
      { from: 'a@b.com', subject: 'Re: 报价单', inReplyTo: undefined, references: ['<old@x.com>', '<tip@qq.com>'] },
      'established',
      lookup(),
    )
    expect(decision.kind).toBe('thread')
  })

  it('主人来信且未命中线程 → 新建分身', () => {
    const decision = routeMessage(
      { from: 'boss@163.com', subject: '帮我查一下上周的报表', inReplyTo: undefined, references: [] },
      'owner',
      lookup(),
    )
    expect(decision.kind).toBe('owner-new')
  })

  it('信任对端的新话题 → 走信任分支而非陌生', () => {
    const decision = routeMessage(
      { from: 'client@corp.com', subject: '新的事情', inReplyTo: undefined, references: [] },
      'established',
      lookup(),
    )
    expect(decision.kind).toBe('trusted-new')
  })

  it('陌生发件人 → 走识别分支', () => {
    const decision = routeMessage(
      { from: 'ad@spam.com', subject: '限时优惠', inReplyTo: undefined, references: [] },
      'stranger',
      lookup(),
    )
    expect(decision.kind).toBe('stranger')
  })

  it('携带未知标签时降级到信任判定，并在依据里说明', () => {
    const decision = routeMessage(
      { from: 'boss@163.com', subject: '事情 [#dead99]', inReplyTo: undefined, references: [] },
      'owner',
      lookup(),
    )
    expect(decision.kind).toBe('owner-new')
    expect(decision.reason).toContain('dead99')
  })
})

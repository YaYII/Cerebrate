/**
 * 脱敏工具单元测试：黑名单命中、截断、shortId 稳定性。
 */
import { describe, expect, it } from 'vitest'
import { isRedactKey, summarize, truncate, shortId, REDACT_KEYWORDS } from '../src/features/redact'

describe('redact', () => {
  it('黑名单键判定覆盖中英文敏感字段', () => {
    expect(isRedactKey('password')).toBe(true)
    expect(isRedactKey('userToken')).toBe(true)
    expect(isRedactKey('api_key')).toBe(true)
    expect(isRedactKey('手机号')).toBe(true)
    expect(isRedactKey('skuId')).toBe(false)
    expect(REDACT_KEYWORDS.length).toBeGreaterThan(10)
  })

  it('摘要时黑名单键值替换为星号', () => {
    const out = summarize({ user: 'alice', password: 'p@ss', stock: 3 })
    expect(out).toContain('user: "alice"')
    expect(out).toContain('password: ***')
    expect(out).not.toContain('p@ss')
  })

  it('附加脱敏键与内置黑名单合并', () => {
    const out = summarize({ account: '123456', qty: 2 }, ['account'])
    expect(out).toContain('account: ***')
    expect(out).toContain('qty: 2')
  })

  it('长文本截断', () => {
    const long = 'x'.repeat(300)
    const out = summarize(long)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(truncate('短文本', 10)).toBe('短文本')
  })

  it('shortId 长度稳定且同种子同结果', () => {
    expect(shortId('a').length).toBe(6)
    expect(shortId('abc', 8).length).toBe(8)
    expect(shortId('seed')).toBe(shortId('seed'))
  })
})

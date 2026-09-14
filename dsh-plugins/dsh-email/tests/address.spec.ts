/**
 * 收件人解析砖块的单元测试：覆盖模型输入的各种形态与回退规则。
 */
import { describe, expect, it } from 'vitest'
import { parseAddresses, resolveRecipients } from '../src/features/address'

/** 默认收件人测试常量。 */
const DEFAULT_TO = 'yangying19911113@163.com'

describe('parseAddresses 地址解析', () => {
  it('单个地址原样返回', () => {
    expect(parseAddresses('a@b.com')).toEqual({ addresses: ['a@b.com'], invalid: [] })
  })

  it('支持英文逗号、中文逗号、分号与空白混用', () => {
    const parsed = parseAddresses('a@b.com, c@d.com；e@f.com\ng@h.com')
    expect(parsed.addresses).toEqual(['a@b.com', 'c@d.com', 'e@f.com', 'g@h.com'])
    expect(parsed.invalid).toEqual([])
  })

  it('按小写去重且保留首次出现的书写形式', () => {
    const parsed = parseAddresses('A@B.com, a@b.com')
    expect(parsed.addresses).toEqual(['A@B.com'])
  })

  it('挑出非法片段而不是静默丢弃', () => {
    const parsed = parseAddresses('a@b.com, 不是邮箱, c@')
    expect(parsed.addresses).toEqual(['a@b.com'])
    expect(parsed.invalid).toEqual(['不是邮箱', 'c@'])
  })

  it('undefined 与空串得到空结果', () => {
    expect(parseAddresses(undefined)).toEqual({ addresses: [], invalid: [] })
    expect(parseAddresses('   ')).toEqual({ addresses: [], invalid: [] })
  })
})

describe('resolveRecipients 收件人回退规则', () => {
  it('未提供收件人时使用默认收件人', () => {
    const result = resolveRecipients(undefined, DEFAULT_TO)
    expect(result).toEqual({ ok: true, recipients: [DEFAULT_TO], source: 'default' })
  })

  it('提供空串等同未提供，回退默认收件人', () => {
    const result = resolveRecipients('   ', DEFAULT_TO)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.source).toBe('default')
  })

  it('用户给了新地址就发到新地址', () => {
    const result = resolveRecipients('new@example.com', DEFAULT_TO)
    expect(result).toEqual({ ok: true, recipients: ['new@example.com'], source: 'explicit' })
  })

  it('支持一次发给多个新地址', () => {
    const result = resolveRecipients('a@x.com,b@y.com', DEFAULT_TO)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.recipients).toEqual(['a@x.com', 'b@y.com'])
  })

  it('新地址非法时报错而不是悄悄回退默认收件人', () => {
    const result = resolveRecipients('不是邮箱', DEFAULT_TO)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('收件人邮箱格式不合法')
  })

  it('默认收件人配置非法时报错', () => {
    const result = resolveRecipients(undefined, '坏地址')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('默认收件人配置不合法')
  })
})

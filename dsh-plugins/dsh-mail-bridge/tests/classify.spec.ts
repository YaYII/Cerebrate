/**
 * 陌生来信识别砖块测试：规则预筛与模型结论解析。
 */
import { describe, expect, it } from 'vitest'
import { classifyPrompt, interpretVerdict, isObviousSpam } from '../src/features/classify'

/** 构造来信摘要。 */
function mail(patch: Partial<{ fromAddress: string; subject: string; text: string }> = {}) {
  return { fromAddress: 'someone@example.com', subject: '你好', text: '想问一下报价', ...patch }
}

describe('isObviousSpam 规则预筛', () => {
  it('机器发件人一律按垃圾处理', () => {
    expect(isObviousSpam(mail({ fromAddress: 'noreply@shop.com' }))).toBe(true)
    expect(isObviousSpam(mail({ fromAddress: 'mailer-daemon@qq.com' }))).toBe(true)
  })

  it('识别常见广告特征词', () => {
    expect(isObviousSpam(mail({ subject: '限时优惠，点击领取' }))).toBe(true)
    expect(isObviousSpam(mail({ text: '专业代开发票，税点优惠' }))).toBe(true)
    expect(isObviousSpam(mail({ text: '加群荐股，稳赚不赔' }))).toBe(true)
  })

  it('正常业务来信不被误判', () => {
    expect(isObviousSpam(mail({ subject: '关于下季度合作的确认', text: '麻烦确认一下合同条款' }))).toBe(false)
  })
})

describe('classifyPrompt 提示词', () => {
  it('包含判定标准与发件人信息，并要求只回一个词', () => {
    const prompt = classifyPrompt(mail({ fromAddress: 'a@b.com', subject: '提问' }))
    expect(prompt).toContain('SPAM')
    expect(prompt).toContain('MEANINGFUL')
    expect(prompt).toContain('a@b.com')
    expect(prompt).toContain('只输出一个词')
  })
})

describe('interpretVerdict 结果解析', () => {
  it('容忍模型输出中的多余文字与大小写', () => {
    expect(interpretVerdict('SPAM')).toBe('spam')
    expect(interpretVerdict(' meaningful \n')).toBe('meaningful')
    expect(interpretVerdict('这封邮件是 MEANINGFUL 的')).toBe('meaningful')
  })

  it('无法判定时返回 unknown', () => {
    expect(interpretVerdict('我不确定')).toBe('unknown')
  })
})

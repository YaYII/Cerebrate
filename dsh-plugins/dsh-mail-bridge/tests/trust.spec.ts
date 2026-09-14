/**
 * 信任判定砖块测试：主人 / 授权数组 / 出站建立信任 / 陌生 四档判定。
 */
import { describe, expect, it } from 'vitest'
import { canTrigger, classifyTrust, normalizeAddress } from '../src/features/trust'

/** 简单配置。 */
const CONFIG = { owner: 'boss@163.com', allowedSenders: ['partner@example.com'] }

describe('normalizeAddress 地址归一', () => {
  it('去尖括号与空白并转小写', () => {
    expect(normalizeAddress('  <Foo@Bar.COM> ')).toBe('foo@bar.com')
    expect(normalizeAddress('foo@bar.com')).toBe('foo@bar.com')
  })
})

describe('classifyTrust 信任分级', () => {
  it('主人邮箱最高权限（大小写不敏感）', () => {
    expect(classifyTrust('BOSS@163.com', CONFIG, new Set())).toBe('owner')
  })

  it('配置数组里的地址为显式授权', () => {
    expect(classifyTrust('partner@example.com', CONFIG, new Set())).toBe('authorized')
  })

  it('我们发过邮件的对端按出站建立信任', () => {
    expect(classifyTrust('client@corp.com', CONFIG, new Set(['client@corp.com']))).toBe('established')
  })

  it('其余按陌生处理', () => {
    expect(classifyTrust('spammer@ad.com', CONFIG, new Set(['client@corp.com']))).toBe('stranger')
  })

  it('空地址按陌生处理', () => {
    expect(classifyTrust('', CONFIG, new Set())).toBe('stranger')
  })
})

describe('canTrigger 触发资格', () => {
  it('主人/授权/出站建立均可触发，陌生不可', () => {
    expect(canTrigger('owner')).toBe(true)
    expect(canTrigger('authorized')).toBe(true)
    expect(canTrigger('established')).toBe(true)
    expect(canTrigger('stranger')).toBe(false)
  })
})

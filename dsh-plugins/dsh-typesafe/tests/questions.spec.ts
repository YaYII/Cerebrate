/**
 * 问题构造与校验的单测 —— 覆盖三种原语的合法形状与非法边界。
 *
 * 本文件干什么：验证 choice/noul/score 的构造函数与校验规则（边界输入必须显式失败）。
 * 本文件不干什么：不发网络请求（那是 client.spec.ts 与 tools.spec.ts 的事）。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

import { describe, expect, it } from 'vitest'
import { TypeSafeError } from '../src/features/primitives'
import { choice, noul, score, validateQuestion, validateQuestions } from '../src/features/questions'

describe('原语构造函数', () => {
  it('choice 生成带 criteria 的问题声明', () => {
    const spec = choice('这封工单属于哪个团队？', { billing: '账单或订阅问题', technical: '缺陷或集成问题', other: '其他' })
    expect(spec.type).toBe('choice')
    expect(Object.keys(spec.criteria ?? {})).toHaveLength(3)
  })

  it('noul 只带 instructions（没有单独 confidence 字段）', () => {
    const spec = noul('这条消息是否表达了紧急？')
    expect(spec.type).toBe('noul')
    expect(spec.criteria).toBeUndefined()
  })

  it('score 保留等级顺序', () => {
    const spec = score('客户的不满程度', ['平静陈述事实', '不满但克制', '非常愤怒'])
    expect(spec.type).toBe('score')
    expect(spec.levels).toEqual(['平静陈述事实', '不满但克制', '非常愤怒'])
  })
})

describe('问题校验：非法输入必须显式失败（而不是静默降级）', () => {
  it('拒绝未知类型', () => {
    expect(() => validateQuestion('x', { type: 'ranking', instructions: '排序' })).toThrow(TypeSafeError)
  })

  it('拒绝非对象', () => {
    expect(() => validateQuestion('x', 'noul')).toThrow(TypeSafeError)
  })

  it('拒绝缺少 instructions（模型看不到问题 id，没有依据就无法判断）', () => {
    expect(() => validateQuestion('x', { type: 'noul' })).toThrow(/instructions/)
  })

  it('拒绝空字符串 instructions', () => {
    expect(() => validateQuestion('x', { type: 'noul', instructions: '   ' })).toThrow(/instructions/)
  })

  it('接受结构化 instructions（对象形式）', () => {
    const spec = validateQuestion('x', { type: 'noul', instructions: { question: '是否紧急', 说明: '按语气与时限判断' } })
    expect(spec.type).toBe('noul')
  })

  it('拒绝只有 1 个选项的 choice（一个选项不是选择）', () => {
    expect(() => validateQuestion('x', { type: 'choice', instructions: '选一个', criteria: { only: '唯一' } })).toThrow(/至少需要 2 个选项/)
  })

  it('拒绝缺少语义说明的 choice 选项（空字符串值）', () => {
    expect(() => validateQuestion('x', { type: 'choice', instructions: '选一个', criteria: { a: 'A 的含义', b: '  ' } })).toThrow(/缺少语义说明/)
  })

  it('拒绝少于 2 个等级的 score（单等级无法表达程度）', () => {
    expect(() => validateQuestion('x', { type: 'score', instructions: '程度', levels: ['只有一个'] })).toThrow(/至少需要 2 个等级/)
  })

  it('拒绝空问题表', () => {
    expect(() => validateQuestions({})).toThrow(/不能为空/)
  })

  it('拒绝把数组当问题表', () => {
    expect(() => validateQuestions([{ type: 'noul', instructions: 'x' }])).toThrow(TypeSafeError)
  })

  it('整表校验保留每个问题 id 且全部通过时返回规范形状', () => {
    const specs = validateQuestions({
      urgency: { type: 'noul', instructions: '是否紧急' },
      team: { type: 'choice', instructions: '哪个团队', criteria: { a: 'A', b: 'B' } },
      anger: { type: 'score', instructions: '愤怒程度', levels: ['低', '高'] },
    })
    expect(Object.keys(specs).sort()).toEqual(['anger', 'team', 'urgency'])
    expect(specs.team?.type).toBe('choice')
  })
})

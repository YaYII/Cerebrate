/**
 * 工具编排层单测 —— 入参校验、密钥来源诊断、密钥不外泄、摘要渲染。
 *
 * 本文件干什么：验证 business 层的校验与诊断行为，网络调用一律用注入的 fetch 替身。
 * 本文件不干什么：不做真实连通性验证（那是 scripts/verify-live.ts 的事）。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

import { describe, expect, it, vi } from 'vitest'
import { summarizeJudgement, tsJudge, tsStatus, type ToolConfig } from '../src/business/tools'
import type { FetchLike } from '../src/features/client'
import { TypeSafeError, type JudgementResult } from '../src/features/primitives'

/** 一个必然失败的探测替身（用于验证错误路径，不触碰真实网络）。 */
const failingFetch: FetchLike = async () => ({ ok: false, status: 500, text: async () => 'boom' })

describe('ts_judge 入参校验', () => {
  it('缺少 state 时抛 invalid 错误（显式，而不是拿空状态去猜）', async () => {
    await expect(tsJudge({}, { questions: { a: { type: 'noul', instructions: 'x' } } })).rejects.toThrow(TypeSafeError)
  })

  it('问题表非法时抛 invalid 错误', async () => {
    await expect(tsJudge({}, { state: 'hi', questions: {} })).rejects.toThrow(/不能为空/)
  })

  it('缺少密钥时抛 config 错误（错误信息指向密钥来源，不泄露任何值）', async () => {
    const config: ToolConfig = { apiKeyEnv: 'TS_DEFINITELY_UNSET_KEY', apiKeyFile: '/nonexistent/typesafe-key' }
    await expect(tsJudge(config, { state: 'hi', questions: { a: { type: 'noul', instructions: 'x' } } })).rejects.toThrow(/console.typesafe.ai\/keys/)
  })
})

describe('ts_status 诊断', () => {
  it('密钥不可用时 ok=false 且 keySource=missing，并给出可操作原因', async () => {
    const report = await tsStatus({ apiKeyEnv: 'TS_DEFINITELY_UNSET_KEY', apiKeyFile: '/nonexistent/typesafe-key' })
    expect(report.ok).toBe(false)
    expect(report.keySource).toBe('missing')
    expect(report.probe).toContain('密钥不可用')
  })

  it('报告密钥来源类别，但绝不回显密钥值', async () => {
    const secret = 'apikey_should_never_appear_in_output'
    const report = await tsStatus({ apiKey: secret, fetchImpl: failingFetch, maxAttempts: 1 })
    expect(report.keySource).toBe('config')
    for (const value of Object.values(report)) {
      expect(String(value)).not.toContain(secret)
    }
  })

  it('探测成功时给出服务端真实模型版本与用量', async () => {
    const impl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: { reachable: { type: 'noul', noul: 1 } }, usage: { input_tokens: 30, output_tokens: 2 } }),
    })
    const report = await tsStatus({ apiKey: 'k', fetchImpl: impl })
    expect(report.ok).toBe(true)
    expect(report.servedModel).toBe('jev-1.13.0')
    expect(report.usage).toEqual({ inputTokens: 30, outputTokens: 2 })
  })

  it('探测失败时 ok=false 但不抛异常（诊断工具自己不能崩）', async () => {
    const report = await tsStatus({ apiKey: 'k', fetchImpl: failingFetch, maxAttempts: 1 })
    expect(report.ok).toBe(false)
    expect(report.probe).toContain('探测失败')
  })

  it('环境变量为空白时视为不可用（不当成有效密钥）', async () => {
    vi.stubEnv('TS_BLANK_KEY', '   ')
    const report = await tsStatus({ apiKeyEnv: 'TS_BLANK_KEY', apiKeyFile: '/nonexistent/typesafe-key' })
    vi.unstubAllEnvs()
    expect(report.ok).toBe(false)
    expect(report.keySource).toBe('missing')
  })
})

describe('摘要渲染', () => {
  it('把三种答案压成可扫读的一行', () => {
    const result: JudgementResult = {
      model: 'jev-1.13.0',
      usage: { inputTokens: 100, outputTokens: 20 },
      answers: {
        team: { type: 'choice', choice: 'technical', confidence: 0.73, probabilities: { technical: 0.82, billing: 0.18 } },
        urgent: { type: 'noul', noul: 0.98 },
        anger: { type: 'score', score: 2, confidence: 1, legend: { '2': '愤怒' }, probabilities: { '2': 1 } },
      },
    }
    const summary = summarizeJudgement(result)
    expect(summary).toContain('team=technical(0.73)')
    expect(summary).toContain('urgent=0.98')
    expect(summary).toContain('anger=2(1.00)')
    expect(summary).toContain('jev-1.13.0')
  })
})

describe('state 形态契约（官方：string | object | array）', () => {
  it('字符串状态可用', async () => {
    const impl: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.9 } } }) })
    const result = await tsJudge({ apiKey: 'k', fetchImpl: impl }, { state: 'my card was charged twice', questions: { a: { type: 'noul', instructions: 'x' } } })
    expect(result.answers.a?.type).toBe('noul')
  })

  it('数组状态可用（消息/记录序列）', async () => {
    const impl: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.9 } } }) })
    const result = await tsJudge({ apiKey: 'k', fetchImpl: impl }, { state: ['hi', 'my card was charged twice'], questions: { a: { type: 'noul', instructions: 'x' } } })
    expect(result.answers.a?.type).toBe('noul')
  })

  it('拒绝数字/布尔/null 状态（它们在 JSON 里合法但没有可判断的内容）', async () => {
    for (const bad of [42, true, null]) {
      await expect(tsJudge({ apiKey: 'k' }, { state: bad, questions: { a: { type: 'noul', instructions: 'x' } } })).rejects.toThrow(/state 必须是字符串、对象或数组/)
    }
  })
})

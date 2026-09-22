/**
 * HTTP 客户端砖块单测 —— 密钥解析优先级、回包规范化、重试策略。
 *
 * 本文件干什么：用**注入的 fetch 替身**验证客户端行为，全程不发真实网络请求。
 * 本文件不干什么：不做真实连通性验证（那是 scripts/verify-live.ts 的事，需显式运行）。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, resolveApiKey, parseResponse, TypeSafeClient, type FetchLike } from '../src/features/client'
import { TypeSafeError } from '../src/features/primitives'

/** 官方 quickstart 的真实回包形状（choice + score + noul 三种答案）。 */
const REAL_SHAPE = JSON.stringify({
  model: 'jev-1.13.0',
  answers: {
    department: { type: 'choice', choice: 'technical', confidence: 0.78, probabilities: { technical: 0.85, sales: 0, billing: 0.15 } },
    frustration: { type: 'score', score: 1, confidence: 1, legend: { '0': '平静', '1': '不满', '2': '愤怒' }, probabilities: { '0': 0, '1': 1, '2': 0 } },
    is_urgent: { type: 'noul', noul: 1 },
  },
  usage: { input_tokens: 392, output_tokens: 65 },
})

describe('密钥解析优先级', () => {
  const saved = process.env.TS_TEST_KEY
  afterEach(() => {
    if (saved === undefined) delete process.env.TS_TEST_KEY
    else process.env.TS_TEST_KEY = saved
  })

  it('显式配置优先于环境变量', () => {
    process.env.TS_TEST_KEY = 'from-env'
    expect(resolveApiKey({ apiKey: 'from-config', apiKeyEnv: 'TS_TEST_KEY' })).toBe('from-config')
  })

  it('环境变量优先于密钥文件', () => {
    process.env.TS_TEST_KEY = 'from-env'
    expect(resolveApiKey({ apiKeyEnv: 'TS_TEST_KEY', apiKeyFile: '/nonexistent/path' })).toBe('from-env')
  })

  it('回落到密钥文件', () => {
    delete process.env.TS_TEST_KEY
    const dir = mkdtempSync(join(tmpdir(), 'ts-key-'))
    const file = join(dir, 'typesafe-api-key')
    writeFileSync(file, 'from-file\n', 'utf8')
    expect(resolveApiKey({ apiKeyEnv: 'TS_TEST_KEY', apiKeyFile: file })).toBe('from-file')
  })

  it('三处都没有时抛可操作的 config 错误（含密钥获取地址）', () => {
    delete process.env.TS_TEST_KEY
    const dir = mkdtempSync(join(tmpdir(), 'ts-key-empty-'))
    try {
      resolveApiKey({ apiKeyEnv: 'TS_TEST_KEY', apiKeyFile: join(dir, 'missing') })
      expect.unreachable('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(TypeSafeError)
      expect((error as TypeSafeError).kind).toBe('config')
      expect((error as TypeSafeError).message).toContain('console.typesafe.ai/keys')
    }
  })
})

describe('回包规范化', () => {
  it('解析三种答案与用量', () => {
    const result = parseResponse(REAL_SHAPE, DEFAULT_MODEL)
    expect(result.model).toBe('jev-1.13.0')
    expect(result.usage).toEqual({ inputTokens: 392, outputTokens: 65 })
    const dept = result.answers.department
    expect(dept?.type).toBe('choice')
    const frustration = result.answers.frustration
    expect(frustration?.type === 'score' && frustration.legend['1']).toBe('不满')
    const urgent = result.answers.is_urgent
    expect(urgent?.type === 'noul' && urgent.noul).toBe(1)
  })

  it('丢弃形状不认识的答案，不伪造结果', () => {
    const result = parseResponse(JSON.stringify({ model: 'm', answers: { broken: { type: 'choice' }, ok: { type: 'noul', noul: 0.5 } } }), 'm')
    expect(result.answers.broken).toBeUndefined()
    expect(result.answers.ok).toBeDefined()
  })

  it('usage 缺失时返回 null（而不是伪造 0，避免成本核算失真）', () => {
    expect(parseResponse(JSON.stringify({ answers: {} }), 'm').usage).toBeNull()
  })

  it('回包非法 JSON 抛 invalid 错误', () => {
    expect(() => parseResponse('<html>502</html>', 'm')).toThrow(TypeSafeError)
  })

  it('回包缺 model 时回落到请求别名', () => {
    expect(parseResponse(JSON.stringify({ answers: {} }), 'jev-latest').model).toBe('jev-latest')
  })
})

describe('请求行为', () => {
  it('使用 Bearer 鉴权、默认 endpoint 与默认模型，并回传判定结果', async () => {
    let seenUrl = ''
    let seenInit: { headers: Record<string, string>; body: string } | undefined
    const impl: FetchLike = async (url, init) => {
      seenUrl = url
      seenInit = { headers: init.headers, body: init.body }
      return { ok: true, status: 200, text: async () => REAL_SHAPE }
    }
    const client = new TypeSafeClient({ apiKey: 'secret-key', fetchImpl: impl })
    const result = await client.judge({ state: 'hello', questions: { a: { type: 'noul', instructions: 'is it hello' } } })
    expect(seenUrl).toBe(DEFAULT_ENDPOINT)
    expect(seenInit?.headers.Authorization).toBe('Bearer secret-key')
    expect(JSON.parse(seenInit?.body ?? '{}').model).toBe(DEFAULT_MODEL)
    expect(result.answers.department).toBeDefined()
  })

  it('结果与错误里都不含密钥明文（密钥绝不外泄）', async () => {
    const impl: FetchLike = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
    const client = new TypeSafeClient({ apiKey: 'super-secret', fetchImpl: impl, maxAttempts: 1 })
    try {
      await client.judge({ state: 'x', questions: { a: { type: 'noul', instructions: 'q' } } })
      expect.unreachable('应当抛错')
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret')
    }
  })

  it('401 不重试（客户端错误重试没有意义）', async () => {
    const spy = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }))
    const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: spy as unknown as FetchLike })
    await expect(client.judge({ state: 'x', questions: { a: { type: 'noul', instructions: 'q' } } })).rejects.toThrow(/HTTP 401/)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('503 会重试，最终成功后返回结果', async () => {
    let calls = 0
    const impl: FetchLike = async () => {
      calls += 1
      if (calls === 1) return { ok: false, status: 503, text: async () => 'unavailable' }
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'm', answers: { a: { type: 'noul', noul: 1 } } }) }
    }
    const client = new TypeSafeClient({ apiKey: 'k', fetchImpl: impl, maxAttempts: 3 })
    const result = await client.judge({ state: 'x', questions: { a: { type: 'noul', instructions: 'q' } } })
    expect(calls).toBe(2)
    expect(result.answers.a?.type).toBe('noul')
  })
})

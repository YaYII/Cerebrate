import { describe, it, expect } from 'vitest'
import { SearXNGSearchProvider } from '../src/features/searxng'

describe('SearXNG provider 真实服务集成（需本地 SearXNG 运行）', () => {
  it('真实搜索 DeepSeek 返回来源', async () => {
    const provider = new SearXNGSearchProvider({ baseURL: 'http://127.0.0.1:18080', language: 'zh-CN', timeoutMs: 15000, numResults: 5 })
    const result = await provider.search({ query: 'DeepSeek 深度求索 开源模型' })
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources[0]?.url).toMatch(/^https?:\/\//)
    expect(result.truncated).toBe(false)
  }, 30000)
})

import { describe, it, expect } from 'vitest'
import { SearXNGSearchProvider, mapSearXNGResult, mapSearXNGResponse } from '../src/features/searxng'
import { parsePage } from '../src/features/reader'
import type { ClientConfig } from '../src/features/rest'

/** 测试用配置：指向不存在的服务，验证结构化失败路径。 */
const config: ClientConfig = {
  searxngUrl: 'http://127.0.0.1:1', // 必然连接失败
  crawl4aiUrl: 'http://127.0.0.1:1', // 必然连接失败（触发双后端）
  crawl4aiToken: 'test-token',
  jinaReaderUrl: 'http://127.0.0.1:1',
  timeoutMs: 2000,
  maxResults: 5,
}

describe('dsh-web-search 功能层', () => {
  it('映射单条 SearXNG 结果：URL 必有，title/snippet 有则带', () => {
    const source = mapSearXNGResult({ url: 'https://a.com', title: '标题', content: '摘要' })
    expect(source).toEqual({ url: 'https://a.com', title: '标题', snippet: '摘要' })
  })

  it('映射无 URL 的结果时丢弃', () => {
    expect(mapSearXNGResult({ title: '无URL' })).toBeUndefined()
  })

  it('映射 SearXNG 响应信封', () => {
    const out = mapSearXNGResponse({
      results: [
        { url: 'https://a.com', title: 'A', content: '甲' },
        { title: '无URL' },
        { url: 'https://b.com' },
      ],
    })
    expect(out.sources).toHaveLength(2)
    expect(out.sources[0]).toEqual({ url: 'https://a.com', title: 'A', snippet: '甲' })
    expect(out.sources[1]).toEqual({ url: 'https://b.com' })
    expect(out.truncated).toBe(false)
  })

  it('搜索 provider 后端不可达时抛 WEB_PROVIDER_ERROR', async () => {
    const provider = new SearXNGSearchProvider({ baseURL: 'http://127.0.0.1:1', language: 'zh-CN', timeoutMs: 1500 })
    expect(provider.available()).toBe(true)
    await expect(provider.search({ query: '测试' })).rejects.toThrow()
  })

  it('无任何解析后端时返回可操作错误', async () => {
    const bare: ClientConfig = { ...config, crawl4aiUrl: '', jinaReaderUrl: '' }
    const out = await parsePage(bare, 'https://example.com')
    expect(out.ok).toBe(false)
    expect(out.backend).toBe('none')
    expect(out.error).toContain('未配置')
  })

  it('双后端都失败时返回合并错误', async () => {
    const out = await parsePage(config, 'https://example.com')
    expect(out.ok).toBe(false)
    expect(out.backend).toBe('both')
    expect(out.error).toContain('crawl4ai')
    expect(out.error).toContain('Jina')
  })
})

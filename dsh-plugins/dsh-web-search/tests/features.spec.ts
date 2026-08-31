import { describe, it, expect } from 'vitest'
import { searchWeb } from '../src/features/searxng'
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
  it('搜索后端不可达时返回结构化错误而非抛异常', async () => {
    const out = await searchWeb(config, '测试', 'zh-CN', 5)
    expect(out.ok).toBe(false)
    expect(out.error).toBeTruthy()
    expect(out.hits).toEqual([])
  })

  it('无任何解析后端时返回可操作错误', async () => {
    const bare: ClientConfig = { ...config, crawl4aiUrl: '', jinaReaderUrl: '' }
    const out = await parsePage(bare, 'https://example.com')
    expect(out.ok).toBe(false)
    expect(out.backend).toBe('none')
    expect(out.error).toContain('未配置')
  })

  it('crawl4ai 不可达且无 Jina 兜底时返回 crawl4ai 错误', async () => {
    const onlyCrawl: ClientConfig = { ...config, crawl4aiUrl: 'http://127.0.0.1:1', jinaReaderUrl: '' }
    const out = await parsePage(onlyCrawl, 'https://example.com')
    expect(out.ok).toBe(false)
    expect(out.backend).toBe('crawl4ai')
    expect(out.error).toBeTruthy()
  })

  it('双后端都失败时返回合并错误', async () => {
    const out = await parsePage(config, 'https://example.com')
    expect(out.ok).toBe(false)
    expect(out.backend).toBe('both')
    expect(out.error).toContain('crawl4ai')
    expect(out.error).toContain('Jina')
  })
})

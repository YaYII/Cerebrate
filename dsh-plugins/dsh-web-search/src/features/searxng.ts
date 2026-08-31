/**
 * SearXNG 元搜索客户端：聚合 Google/Bing/DDG 等，输出 JSON。
 *
 * 只做「向 SearXNG 要搜索结果」这一件事；工具编排在装配层。
 * @module @deepseek-ai/dsh-web-search
 */

import { rawRequest, type ClientConfig, type HttpResult } from './rest'

/** 一条结构化搜索结果。 */
export interface SearchHit {
  /** 结果标题。 */
  title: string
  /** 结果 URL。 */
  url: string
  /** 内容摘要（可能为空）。 */
  content: string
  /** 来源引擎名（google/bing/ddg...）。 */
  engine: string
  /** 分数（SearXNG 排序用，越高越靠前）。 */
  score: number
}

/** SearXNG JSON 响应的解析结果。 */
export interface SearchOutcome {
  ok: boolean
  /** 原始查询词。 */
  query: string
  /** 命中的搜索结果。 */
  hits: SearchHit[]
  /** 失败原因（ok=false 时有值）。 */
  error?: string
}

/** 非 2xx SearXNG 响应的人类可读摘要。 */
export function searxngError(result: HttpResult, op: string): string {
  if (typeof result.body === 'object' && result.body !== null && 'message' in result.body) {
    const m = (result.body as Record<string, unknown>).message
    return op + ': ' + String(m)
  }
  return op + ': HTTP ' + result.status + ' ' + result.raw.slice(0, 200)
}

/**
 * 调用 SearXNG JSON API 搜索。
 * @param config - 连接配置。
 * @param query - 搜索词。
 * @param language - 结果语言（如 zh-CN / en）。
 * @param maxResults - 最多返回条数。
 * @returns 结构化搜索结果；失败时 ok=false 带原因。
 */
export async function searchWeb(
  config: ClientConfig,
  query: string,
  language: string,
  maxResults: number,
): Promise<SearchOutcome> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    language,
    locale: language, // 与语言一致，提升本地化结果质量
    safesearch: '0',
  })
  const result = await rawRequest(config.searxngUrl, 'GET', '/search?' + params.toString(), {}, undefined, config.timeoutMs)
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, query, hits: [], error: searxngError(result, 'SearXNG 搜索失败') }
  }
  const data = result.body as { results?: unknown[] } | null
  const hits: SearchHit[] = []
  if (data && Array.isArray(data.results)) {
    for (const it of data.results.slice(0, maxResults)) {
      const r = it as Record<string, unknown>
      const url = typeof r.url === 'string' ? r.url : ''
      if (url.length === 0) continue
      hits.push({
        title: typeof r.title === 'string' ? r.title : '',
        url,
        content: typeof r.content === 'string' ? r.content : '',
        engine: typeof r.engine === 'string' ? r.engine : '',
        score: typeof r.score === 'number' ? r.score : 0,
      })
    }
  }
  return { ok: true, query, hits }
}

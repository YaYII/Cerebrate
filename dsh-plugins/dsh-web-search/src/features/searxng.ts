/**
 * `SearXNGSearchProvider`: 一个由自托管 SearXNG 元搜索支撑的 WebSearchProvider。
 *
 * 它实现 `@deepseek-ai/dsh-web` 的 `WebSearchProvider` 接缝契约，注册进
 * `ctx.web` 的 provider 注册表——与 Exa/Perplexity/DeepSeek 官方 provider
 * 同级，但完全自托管、无 API key。模型侧的 `web_search` 工具由
 * `@deepseek-ai/dsh-tool-web` 提供，本 provider 只负责「把查询变成结果」。
 *
 * 映射规则：SearXNG 的 `results[]` 逐条映射为 `WebSearchSource`（url 必有，
 * title/snippet 有则带）；SearXNG 不返回生成式回答，故省略 `content`。
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** 本 provider 注册用的稳定 id。 */
export const SEARXNG_PROVIDER_ID = 'searxng-local'

/** 默认 SearXNG 服务地址（本机自托管）。 */
export const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:18080'

/** 默认搜索语言（与 locale 一致以提升本地化结果质量）。 */
export const SEARXNG_DEFAULT_LANGUAGE = 'zh-CN'

/** 默认单次请求超时（毫秒）。 */
export const SEARXNG_DEFAULT_TIMEOUT_MS = 15_000

/** 归属请求头（随包版本递增）。 */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** 已解析的 provider 选项（插件 apply 提供配置默认值）。 */
export interface SearXNGProviderOptions {
  /** SearXNG 服务地址（/search 会被追加）。 */
  baseURL: string
  /** 搜索语言，如 zh-CN / en。 */
  language: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number
  /** 请求无 maxResults 时的默认条数。 */
  numResults?: number
}

/** 校验 baseURL 可解析且为 http(s)。 */
function isValidBaseUrl(baseURL: string): boolean {
  try {
    const url = new URL(baseURL)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 映射一条 SearXNG 结果到归一化 source；URL 缺失时丢弃。 */
export function mapSearXNGResult(result: Record<string, unknown>): WebSearchSource | undefined {
  const url = typeof result.url === 'string' ? result.url.trim() : ''
  if (url.length === 0) return undefined
  const title = typeof result.title === 'string' ? result.title : ''
  const content = typeof result.content === 'string' ? result.content : ''
  return {
    url,
    ...title.length > 0 ? { title } : {},
    ...content.length > 0 ? { snippet: content } : {},
  }
}

/**
 * 映射 SearXNG JSON 响应信封到归一化搜索结果。
 * @param response - 解析后的 /search 响应体。
 * @returns 归一化结果；无 URL 的条目被丢弃。
 */
export function mapSearXNGResponse(response: { results?: unknown[] } | null): WebSearchResult {
  const sources = (response?.results ?? [])
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(mapSearXNGResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // SearXNG 不返回生成式回答，故省略 content；最终 maxResults 截断由
  // dsh-web 服务层负责，因此本 provider 报告 truncated: false。
  return { sources, truncated: false }
}

/** SearXNG 支撑的搜索 provider；HTTP 失败以 WEB_PROVIDER_ERROR 呈现。 */
export class SearXNGSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearXNGProviderOptions) {}

  available(): boolean {
    return isValidBaseUrl(this.options.baseURL)
      && this.options.timeoutMs > 0
      && (this.options.numResults === undefined || this.options.numResults > 0)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // 单请求 bound 优先于配置默认；两者皆可缺席。
    const limit = request.maxResults ?? this.options.numResults
    const params = new URLSearchParams({
      q: request.query,
      format: 'json',
      language: this.options.language,
      locale: this.options.language, // 与语言一致，提升本地化结果质量
      safesearch: '0',
    })
    if (limit !== undefined) params.set('max_results', String(limit))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)

    try {
      const response = await fetch(this.options.baseURL.replace(/\/$/, '') + '/search?' + params.toString(), {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new WebError('WEB_PROVIDER_ERROR', 'SearXNG 搜索失败: HTTP ' + response.status)
      }
      const data = await response.json() as { results?: unknown[] } | null
      return mapSearXNGResponse(data)
    } catch (error) {
      if (signal?.aborted) throw new WebError('WEB_CANCELLED', '搜索已取消')
      if (controller.signal.aborted) {
        throw new WebError('WEB_TIMEOUT', 'SearXNG 搜索超时（' + this.options.timeoutMs + 'ms）')
      }
      if (error instanceof WebError) throw error
      throw new WebError('WEB_PROVIDER_ERROR', 'SearXNG 搜索失败: ' + String(error instanceof Error ? error.message : error))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

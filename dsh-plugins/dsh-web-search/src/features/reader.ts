/**
 * 网页解析客户端：把任意 URL 转成 LLM 友好的 Markdown/纯文本。
 *
 * 双后端策略：
 * - 首选 crawl4ai（自托管，POST /md 返回 Readability 过滤后的干净 Markdown）；
 * - 不可达时降级 Jina Reader（URL 前缀代理，零部署）。
 * 后端选择在配置层决定，解析层只做「把 URL 变成可读文本」这一件事。
 * @module @deepseek-ai/dsh-web-search
 */

import { rawRequest, type ClientConfig, type HttpResult } from './rest'

/** 一次网页解析的结果。 */
export interface PageOutcome {
  ok: boolean
  /** 目标 URL。 */
  url: string
  /** 解析出的正文（Markdown/纯文本）。 */
  content: string
  /** 使用的后端（crawl4ai / jina-reader）。 */
  backend: string
  /** 失败原因（ok=false 时有值）。 */
  error?: string
}

/** 非 2xx 响应的人类可读摘要。 */
function readerError(result: HttpResult, op: string): string {
  if (typeof result.body === 'object' && result.body !== null && 'message' in result.body) {
    const m = (result.body as Record<string, unknown>).message
    return op + ': ' + String(m)
  }
  return op + ': HTTP ' + result.status + ' ' + result.raw.slice(0, 200)
}

/** 用 crawl4ai 解析：POST /md，body 为 {"url": ..., "f": "fit"}，返回 markdown。 */
async function crawlWithCrawl4ai(config: ClientConfig, url: string): Promise<PageOutcome> {
  const body = JSON.stringify({ url, f: 'fit', c: '0' })
  const headers: Record<string, string> = {}
  if (config.crawl4aiToken.length > 0) headers.Authorization = 'Bearer ' + config.crawl4aiToken
  const result = await rawRequest(config.crawl4aiUrl, 'POST', '/md', headers, body, config.timeoutMs)
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, url, content: '', backend: 'crawl4ai', error: readerError(result, 'crawl4ai 解析失败') }
  }
  const data = result.body as { markdown?: unknown } | null
  const content = data && typeof data.markdown === 'string' ? data.markdown : result.raw
  return { ok: true, url, content, backend: 'crawl4ai' }
}

/** 用 Jina Reader 解析：GET {jinaUrl}/{url}，直接返回 Markdown 文本。 */
async function readWithJina(config: ClientConfig, url: string): Promise<PageOutcome> {
  const target = config.jinaReaderUrl.replace(/\/$/, '') + '/' + encodeURI(url)
  const result = await rawRequest(target, 'GET', '', {}, undefined, config.timeoutMs)
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, url, content: '', backend: 'jina-reader', error: readerError(result, 'Jina Reader 解析失败') }
  }
  return { ok: true, url, content: result.raw, backend: 'jina-reader' }
}

/**
 * 解析一个网页为 LLM 友好文本。
 * @param config - 连接配置。
 * @param url - 目标 URL。
 * @returns 解析结果；双后端都失败时 ok=false 带原因。
 */
export async function parsePage(config: ClientConfig, url: string): Promise<PageOutcome> {
  const useCrawl4ai = config.crawl4aiUrl.length > 0
  if (useCrawl4ai) {
    const viaCrawl = await crawlWithCrawl4ai(config, url)
    if (viaCrawl.ok) return viaCrawl
    // crawl4ai 失败时降级 Jina Reader（若配置了）
    if (config.jinaReaderUrl.length > 0) {
      const viaJina = await readWithJina(config, url)
      if (viaJina.ok) return viaJina
      return { ok: false, url, content: '', backend: 'both', error: 'crawl4ai 失败: ' + (viaCrawl.error ?? '') + '；Jina Reader 失败: ' + (viaJina.error ?? '') }
    }
    return viaCrawl
  }
  if (config.jinaReaderUrl.length > 0) return readWithJina(config, url)
  return { ok: false, url, content: '', backend: 'none', error: '未配置任何解析后端（crawl4aiUrl / jinaReaderUrl 均为空）' }
}

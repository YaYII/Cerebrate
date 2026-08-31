/**
 * dsh-web-search 的底层 HTTP 能力：唯一真正发起网络请求的地方。
 *
 * 设计约束：
 * - 网络失败（DNS/连接拒绝/超时）降级为结构化错误而不是抛异常，
 *   保证工具 execute 永不把 stack 暴露给模型。
 * - 统一超时，避免模型等一个挂死的上游服务。
 * @module @deepseek-ai/dsh-web-search
 */

import http from 'node:http'
import https from 'node:https'
import type { JsonValue } from '@deepseek-ai/dsh-session'

/** 插件运行所需的连接配置（index.ts 的 Config 实现该形状）。 */
export interface ClientConfig {
  /** SearXNG 服务地址。 */
  searxngUrl: string
  /** crawl4ai 服务地址（留空则仅用 Jina Reader）。 */
  crawl4aiUrl: string
  /** crawl4ai API token（服务端未开启鉴权时留空）。 */
  crawl4aiToken: string
  /** Jina Reader 服务地址（自托管或官方 r.jina.ai）。 */
  jinaReaderUrl: string
  /** 单次 HTTP 请求超时（毫秒）。 */
  timeoutMs: number
  /** 搜索结果条数上限。 */
  maxResults: number
}

/** 一次 HTTP 调用的解析结果。 */
export interface HttpResult {
  /** HTTP 状态码。 */
  status: number
  /** 解析后的响应体（JSON 时，否则为原始文本）。 */
  body: unknown
  /** 原始响应文本。 */
  raw: string
}

/** 底层 HTTP 请求：统一超时 + 结构化失败。 */
export function rawRequest(
  baseUrl: string,
  method: string,
  apiPath: string,
  headers: Record<string, string> = {},
  bodyText?: string,
  timeoutMs = 15000,
): Promise<HttpResult> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(baseUrl + apiPath)
    } catch {
      resolve({ status: 0, body: null, raw: 'URL 解析失败: ' + baseUrl + apiPath })
      return
    }
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      url,
      {
        method,
        headers: {
          'User-Agent': 'dsh-web-search/0.1.0',
          Accept: 'application/json',
          ...headers,
          ...(bodyText !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: unknown = raw
          const ct = res.headers['content-type'] ?? ''
          if (ct.includes('application/json')) {
            try { body = JSON.parse(raw) } catch { body = raw }
          }
          resolve({ status: res.statusCode ?? 0, body, raw })
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
    req.on('error', (err) => resolve({ status: 0, body: null, raw: String(err.message) }))
    if (bodyText !== undefined) req.write(bodyText)
    req.end()
  })
}

/** 把任意值转成可 JSON 序列化的对象（供工具返回）。 */
export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

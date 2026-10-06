/**
 * 团队知识库客户端的共享数据形状与底层 HTTP/密钥能力。
 *
 * - 密钥解析（环境变量优先，其次本地文件）对 Obsidian API key 与
 *   Brain token 共用同一形状。
 * - rawRequest 是唯一真正发起 HTTP 请求的地方（http/https 二选一），
 *   网络失败降级为结构化错误而不是抛异常。
 * @module @deepseek-ai/dsh-obsidian
 */

import os from 'node:os'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 插件运行所需的连接配置（index.ts 的 Config 实现该形状）。 */
export interface ClientConfig {
  baseUrl: string
  apiKeyEnv: string
  apiKeyFile: string
  tlsRejectUnauthorized: boolean
  brainUrl: string
  brainTokenEnv: string
  brainTokenFile: string
  user: string
  agentId: string
}

/** Brain 服务端返回的 v5 协议信封。 */
export interface Envelope {
  status: string
  data?: unknown
  error?: { code?: number | string; message?: string }
}

/** 能无损 JSON 往返的通用 JSON 值映射。 */
export type JsonMap = Record<string, JsonValue>

/** 一次 Obsidian REST 调用的解析结果。 */
export interface ObsidianResult {
  /** HTTP 状态码。 */
  status: number
  /** 解析后的响应体（JSON 时，否则为原始文本）。 */
  body: unknown
  /** 原始响应文本。 */
  raw: string
}

/**
 * 解析密钥：优先环境变量，其次本地文件（含指定键的 JSON 信封，或裸文本）。
 * Obsidian API key 与 Brain token 共用此形状。
 * @param envName - 环境变量名。
 * @param file - 本地文件路径（支持 ~ 展开）。
 * @param jsonKey - JSON 信封中存放密钥的键名。
 * @returns 解析到的密钥；两处皆无时为空串。
 */
export async function resolveSecret(envName: string, file: string, jsonKey: string): Promise<string> {
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const path = file.replace(/^~/, os.homedir())
  try {
    const raw = (await readFile(path, 'utf8')).trim()
    if (raw.length === 0) return ''
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && jsonKey in parsed) {
        const v = (parsed as Record<string, unknown>)[jsonKey]
        return typeof v === 'string' ? v : ''
      }
    } catch {
      // 非 JSON：整行即密钥。
    }
    return raw
  } catch {
    return ''
  }
}

/** 按 baseUrl 协议选择请求模块（https 或 http）。 */
export function requestBuilder(baseUrl: string, rejectUnauthorized: boolean) {
  const mod = baseUrl.startsWith('https') ? https : http
  return () => mod
}

/**
 * 发起一次 HTTP 请求（Obsidian Local REST API 或任意 baseUrl）。
 * 解析为 status + 响应体；网络失败降级为结构化错误，让模型看到原因
 * 而不是收到抛出的异常。
 */
export function rawRequest(
  baseUrl: string,
  rejectUnauthorized: boolean,
  method: string,
  apiPath: string,
  headers: Record<string, string>,
  bodyText?: string,
): Promise<ObsidianResult> {
  const url = new URL(baseUrl.replace(/\/+$/, '') + apiPath)
  return new Promise<ObsidianResult>((resolve) => {
    const mod = url.protocol === 'https:' ? https : http
    // 直接传 url.pathname 避免二次编码：URL 对象再序列化时会把已编码的
    // %XX 转成 %25XX（中文笔记名路径会因此 404）；pathname 保留原始编码。
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || undefined,
      protocol: url.protocol,
      path: url.pathname + url.search,
      method,
      headers: { ...headers, ...(bodyText !== undefined ? { 'Content-Length': Buffer.byteLength(bodyText) } : {}) },
      rejectUnauthorized,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: unknown = raw
        try { body = JSON.parse(raw) } catch { /* 非 JSON 响应体 */ }
        resolve({ status: res.statusCode ?? 0, body, raw })
      })
    })
    req.on('error', (error) => {
      const reason = error instanceof Error ? error.message : String(error)
      resolve({ status: 503, body: { error: { message: `无法连接 ${baseUrl}: ${reason}` } }, raw: '' })
    })
    if (bodyText !== undefined) req.write(bodyText)
    req.end()
  })
}

/**
 * 把任意解析后的响应体强制为无损 JSON 值。JSON.parse 的输出已是 JSON 值，
 * 这里是 `unknown` 响应体的类型桥；null/undefined 回退为空对象，让
 * 渲染器总是看到合法记录。
 */
export function toJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return { empty: true }
  return value as JsonValue
}

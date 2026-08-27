/**
 * Obsidian vault 文件层的客户端能力：REST 调用、路径编码、状态探测。
 *
 * 只做「与 vault 通信」这一件事；工具编排（obsidian_* 工具定义）在装配层。
 * @module @deepseek-ai/dsh-obsidian
 */

import { rawRequest, resolveSecret, toJson, type ClientConfig, type JsonMap, type ObsidianResult } from './rest'

/** 解析 Obsidian API key：环境变量优先，其次文件；两处皆无时为空串。 */
async function resolveApiKey(config: ClientConfig): Promise<string> {
  return resolveSecret(config.apiKeyEnv, config.apiKeyFile, 'apiKey')
}

/**
 * 调用 Obsidian REST API；注入 Bearer key 与 JSON 头。
 * @param config - 连接配置。
 * @param method - HTTP 方法。
 * @param apiPath - API 路径（含 /vault/ 前缀的 vault 相对路径等）。
 * @param bodyText - 请求体文本（可选）。
 * @param extraHeaders - 附加请求头。
 * @returns 解析后的响应。
 */
export async function obsidianCall(
  config: ClientConfig,
  method: string,
  apiPath: string,
  bodyText?: string,
  extraHeaders: Record<string, string> = {},
): Promise<ObsidianResult> {
  const key = await resolveApiKey(config)
  return rawRequest(config.baseUrl, config.tlsRejectUnauthorized, method, apiPath, {
    ...(key.length > 0 ? { Authorization: `Bearer ${key}` } : {}),
    ...(bodyText !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...extraHeaders,
  }, bodyText)
}

/** 非 2xx Obsidian 响应的人类可读摘要。 */
export function obsidianError(result: ObsidianResult, op: string): JsonMap {
  if (typeof result.body === 'object' && result.body !== null && 'message' in result.body) {
    const m = (result.body as Record<string, unknown>).message
    return { ok: false, op, status: result.status, error: String(m) }
  }
  return { ok: false, op, status: result.status, error: result.raw.slice(0, 300) }
}

/** 检查 Obsidian REST API 可用性（根路径无需认证）。 */
export async function obsidianStatus(config: ClientConfig): Promise<JsonMap> {
  const result = await rawRequest(config.baseUrl, config.tlsRejectUnauthorized, 'GET', '/', {}, undefined)
  const key = await resolveApiKey(config)
  if (result.status >= 200 && result.status < 300) {
    return { ok: true, baseUrl: config.baseUrl, authenticated: key.length > 0 }
  }
  return { ok: false, baseUrl: config.baseUrl, status: result.status, error: result.raw.slice(0, 200) }
}

/** 探测 Obsidian REST API 是否可达（根路径无需 API key）。 */
export async function probeObsidian(config: ClientConfig): Promise<boolean> {
  try {
    const result = await rawRequest(config.baseUrl, config.tlsRejectUnauthorized, 'GET', '/', {}, undefined)
    return result.status >= 200 && result.status < 300
  } catch {
    return false
  }
}

/** 把路径拼接为 vault 相对的 URL 编码路径（带 /vault/ 前缀）。 */
export function vaultPath(path: string): string {
  const segments = path.split('/').map(encodeURIComponent).join('/')
  return segments.length === 0 ? '/vault/' : '/vault/' + segments
}

/** 导出供装配层渲染工具结果时使用的类型转换。 */
export { toJson }

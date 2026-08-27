/**
 * Brain 服务端（脑虫权威知识库）的客户端能力。
 *
 * 只做「与 Brain 服务端通信」这一件事：v5 协议信封的请求与解析；
 * knowledge_* 工具编排在装配层。
 * @module @deepseek-ai/dsh-obsidian
 */

import { resolveSecret, type ClientConfig, type JsonMap } from './rest'

/**
 * 调用一个 Brain 服务端端点并返回 v5 协议信封。
 * @param config - 连接配置（brainUrl/token 来源）。
 * @param method - HTTP 方法。
 * @param apiPath - API 路径（含 /v1/ 前缀）。
 * @param body - 请求体（可选）。
 * @returns 归一化后的信封（网络失败降级为 503 错误信封）。
 */
export async function brainCall(config: ClientConfig, method: string, apiPath: string, body?: unknown): Promise<JsonMap> {
  const token = await resolveSecret(config.brainTokenEnv, config.brainTokenFile, 'token')
  const url = `${config.brainUrl.replace(/\/$/, '')}${apiPath}`
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token.length > 0 ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    try {
      return JSON.parse(text) as JsonMap
    } catch {
      return { status: 'error', error: { code: response.status, message: text } }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 'error', error: { code: 503, message: `无法连接脑虫服务 ${url}: ${reason}` } }
  }
}

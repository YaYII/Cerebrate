/**
 * 脱敏与摘要工具 —— 所有埋点/行为记录的敏感数据兜底防线。
 *
 * 任何粒度（详细/摘要）下都强制生效：黑名单字段替换为星号，
 * 任意值序列化后超长截断。本文件是纯函数砖块，不依赖业务层。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

/** 敏感字段黑名单（匹配参数名/对象键，大小写不敏感）。 */
export const REDACT_KEYWORDS = [
  'password', 'passwd', 'pwd', 'token', 'access_token', 'refresh_token',
  'secret', 'api_key', 'apikey', 'authorization', 'cookie', 'session_id',
  'phone', 'mobile', 'idcard', 'id_card', 'identity', 'ssn', 'credit_card',
  '身份证', '密码', '手机号', '银行卡', '验证码', '私钥', '密钥',
]

/** 单条摘要的最大长度（字符）。 */
export const MAX_SUMMARY_LENGTH = 120

/**
 * 判断一个键名是否命中脱敏黑名单。
 * @param key - 字段名/参数名。
 * @returns 是否命中。
 */
export function isRedactKey(key: string): boolean {
  const lower = key.toLowerCase()
  return REDACT_KEYWORDS.some(k => lower.includes(k))
}

/**
 * 把任意值转换为脱敏后的摘要文本。
 * - 黑名单键对应的值一律替换为 `***`。
 * - 字符串/数值/布尔原样保留；对象与数组递归摘要。
 * - 最终结果截断到 MAX_SUMMARY_LENGTH 字符。
 * @param value - 要摘要的值（入参/出参/工具参数等）。
 * @param redactKeys - 附加脱敏键（与内置黑名单合并）。
 * @returns 脱敏摘要字符串。
 */
export function summarize(value: unknown, redactKeys: string[] = []): string {
  const extra = redactKeys.map(k => k.toLowerCase())
  const text = stringify(value, (key) => isRedactKey(key) || extra.includes(key.toLowerCase()))
  return truncate(text)
}

/**
 * 递归序列化任意 JSON 兼容值，键命中黑名单时值替换为星号。
 * @param value - 任意值。
 * @param redact - 键判定函数（命中返回 true）。
 * @returns 序列化文本。
 */
function stringify(value: unknown, redact: (key: string) => boolean): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return JSON.stringify(truncate(value, MAX_SUMMARY_LENGTH))
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'symbol') return '[symbol]'
  if (Array.isArray(value)) {
    return `[${value.map(v => stringify(v, redact)).join(', ')}]`
  }
  if (typeof value === 'object') {
    const parts: string[] = []
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (redact(key)) parts.push(`${key}: ***`)
      else parts.push(`${key}: ${stringify(val, redact)}`)
    }
    return `{${parts.join(', ')}}`
  }
  return '[unsupported]'
}

/**
 * 截断文本到指定长度，超长部分以省略号结尾。
 * @param text - 原文。
 * @param max - 最大长度（默认 MAX_SUMMARY_LENGTH）。
 * @returns 截断后文本。
 */
export function truncate(text: string, max: number = MAX_SUMMARY_LENGTH): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/**
 * 生成稳定的短标识（用于 traceId / spanId 等，非加密用途）。
 * 同一种子恒得同一结果（确定性）。
 * @param seed - 随机种子字符。
 * @param length - 输出长度（默认 6）。
 * @returns 短标识。
 */
export function shortId(seed: string = Math.random().toString(36).slice(2), length = 6): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  const abs = Math.abs(hash).toString(36)
  return (abs + abs).slice(0, length).padEnd(length, '0')
}

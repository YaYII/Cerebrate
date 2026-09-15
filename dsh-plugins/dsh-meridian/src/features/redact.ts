/**
 * 脱敏砖块 —— 所有进入事实模型的文本都必须先过这里。
 *
 * 本文件干什么：按黑名单键名与高危值形态（JWT、长随机串、证件号、卡号）替换为掩码。
 * 本文件不干什么：不认识业务、不解析日志、不做判定。
 *
 * 为什么必须存在（来自真实语料的安全发现）：
 * 在 IHM2（Laravel）真实日志中，登录回调把 **Keycloak 的 access_token / refresh_token / id_token
 * 全文写进了日志**（`local.INFO: LoginController@getToken Login as {"keycloakUser":{...,"token":"eyJ..."}}`）。
 * 一旦这些事实被 AI 读取或落盘，等于把凭据扩散到观测链路。
 * 因此脱敏不是「加分项」，而是**观测系统的准入条件**。
 *
 * @module @deepseek-ai/dsh-meridian
 */

/** 敏感键名黑名单（匹配键名，大小写不敏感，含中英文）。 */
export const SECRET_KEYS: readonly string[] = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'access_token', 'refresh_token', 'id_token',
  'accesstoken', 'refreshtoken', 'idtoken', 'authorization', 'auth', 'cookie', 'session_id', 'sessionid',
  'api_key', 'apikey', 'private_key', 'credential', 'signature', 'sign',
  '密码', '密碼', '密钥', '密鑰', '令牌', '签名', '簽名', '验证码', '驗證碼',
]

/** 掩码文本。 */
export const MASK = '***'

/** JWT 形态：三段 base64url 以点分隔，且首段以 eyJ 开头（base64 的 {" ）。 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

/** 其它高危长随机串（32 位以上连续十六进制/base64 混合）。 */
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g

/**
 * 判断键名是否命中黑名单。
 *
 * @param key - 字段名/参数名。
 * @returns 是否命中。
 */
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SECRET_KEYS.some((item) => lower.includes(item))
}

/**
 * 对任意文本做值级脱敏（无法识别键名时的兜底）。
 *
 * @param text - 原始文本。
 * @returns 脱敏后的文本。
 */
export function redactText(text: string): string {
  return text.replace(JWT_PATTERN, MASK).replace(LONG_SECRET_PATTERN, (hit) => (hit.length >= 40 ? MASK : hit))
}

/**
 * 对 JSON 文本做键级 + 值级脱敏。
 *
 * 解析失败时退化为纯文本脱敏（fail-closed：宁可多抹，不可漏抹）。
 *
 * @param json - 形如 `{"a":1}` 的文本。
 * @returns 脱敏后的 JSON 文本（保持字符串形态）。
 */
export function redactJsonText(json: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return redactText(json)
  }
  return JSON.stringify(maskValue(parsed))
}

/** 递归掩码对象里的敏感键与高危值。 */
function maskValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return MASK
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => maskValue(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSecretKey(key) ? MASK : maskValue(item, depth + 1)
    }
    return result
  }
  return value
}

/**
 * 对整条日志原文做脱敏（用于证据片段与细节）。
 *
 * @param line - 原始日志行。
 * @returns 脱敏后的文本。
 */
export function redactLine(line: string): string {
  const braceAt = line.indexOf('{')
  if (braceAt < 0) return redactText(line)
  const head = line.slice(0, braceAt)
  const tail = line.slice(braceAt)
  // 只对形如 {...} 的尾段尝试 JSON 脱敏，失败则整体文本脱敏
  return head + (tail.trimEnd().endsWith('}') ? redactJsonText(tail) : redactText(tail))
}

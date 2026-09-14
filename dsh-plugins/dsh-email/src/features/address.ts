/**
 * 收件人地址解析砖块：把模型给出的「一个字符串」规范化为可用的邮箱地址数组。
 *
 * 为什么单独成砖块：模型输入形态不可控（单地址、英文逗号、中文逗号、分号、
 * 换行混用），解析与校验是纯计算，单独沉淀便于单测覆盖；真正发信的 IO 在
 * smtp.ts，本文件既不碰网络也不碰文件系统。
 *
 * @module @deepseek-ai/dsh-email/features/address
 */

/** 邮箱基本形态校验：本地部分@域名，域名至少含一个点，禁止分隔符与尖括号。 */
const EMAIL_PATTERN = /^[^\s@,;<>，；]+@[^\s@,;<>，；]+\.[^\s@,;<>，；]+$/

/** 地址间隔符：英文/中文逗号、分号与任意空白都算分隔，容忍模型输出的多种写法。 */
const ADDRESS_SEPARATOR = /[,;，；\s]+/

/** 地址解析结果。 */
export interface ParsedAddresses {
  /** 规范化后的地址列表（保持书写顺序，按小写去重）。 */
  addresses: string[]
  /** 形态非法的原始片段，供调用方给出可操作的报错，绝不静默丢弃。 */
  invalid: string[]
}

/**
 * 解析地址串为地址数组，并挑出非法片段。
 * @param input - 原始地址串，可含多种分隔符；undefined 或空串得到空结果。
 * @returns 合法地址与非法的原始片段。
 */
export function parseAddresses(input: string | undefined): ParsedAddresses {
  const addresses: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  if (input === undefined) return { addresses, invalid }
  for (const fragment of input.split(ADDRESS_SEPARATOR)) {
    const address = fragment.trim()
    if (address.length === 0) continue
    if (!EMAIL_PATTERN.test(address)) {
      invalid.push(address)
      continue
    }
    const key = address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    addresses.push(address)
  }
  return { addresses, invalid }
}

/** 收件人的来源：调用方显式指定，或回退到插件配置的默认收件人。 */
export type RecipientSource = 'explicit' | 'default'

/** 收件人解析结果：要么得到非空地址列表，要么得到中文可操作原因。 */
export type RecipientResolution =
  | { ok: true; recipients: string[]; source: RecipientSource }
  | { ok: false; error: string }

/**
 * 决定本次发信的真实收件人。
 *
 * 业务规则（用户明确要求）：调用方给了新地址就用新地址；没给才回退默认收件人。
 * 默认收件人自身配置不合法时直接报错而不是静默回退——避免邮件发到错误的人手里。
 *
 * @param to - 调用方传入的收件人串，可为 undefined。
 * @param defaultRecipient - 插件配置的默认收件人。
 */
export function resolveRecipients(to: string | undefined, defaultRecipient: string): RecipientResolution {
  const explicit = (to ?? '').trim()
  if (explicit.length === 0) {
    const fallback = parseAddresses(defaultRecipient)
    if (fallback.addresses.length !== 1 || fallback.invalid.length > 0) {
      return { ok: false, error: `默认收件人配置不合法：${defaultRecipient}` }
    }
    return { ok: true, recipients: fallback.addresses, source: 'default' }
  }
  const parsed = parseAddresses(explicit)
  if (parsed.invalid.length > 0) {
    return { ok: false, error: `收件人邮箱格式不合法：${parsed.invalid.join('、')}` }
  }
  if (parsed.addresses.length === 0) {
    return { ok: false, error: '收件人邮箱不能为空；如需使用默认收件人请省略 to 参数' }
  }
  return { ok: true, recipients: parsed.addresses, source: 'explicit' }
}

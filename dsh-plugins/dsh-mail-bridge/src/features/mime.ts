/**
 * 邮件解析砖块：把 IMAP 取回的原始报文解析成路由与喂给模型都能用的结构。
 *
 * 为什么用 mailparser 而不是自己解 MIME：QQ 会把中文主题整体做 RFC2047 编码、
 * 长主题拆成相邻多个 encoded-word，正文又是 base64/quoted-printable 的
 * multipart——这些细节实现错了很隐蔽。解析器与 IMAP 客户端都在构建期被
 * 内联进 lib/index.js，部署侧依旧单文件零 node_modules。
 *
 * 本砖块是纯解析：入参是已经取回的报文 Buffer，不发起任何网络 IO。
 *
 * @module @deepseek-ai/dsh-mail-bridge/features/mime
 */

import { simpleParser } from 'mailparser'
import type { AddressObject } from 'mailparser'

/** 附件概要（只留元信息，不落盘）。 */
export interface MailAttachment {
  filename: string
  size: number
  contentType: string
}

/** 解析后的邮件。 */
export interface ParsedMail {
  /** IMAP UID（去重与增量拉取的依据）。 */
  uid: number
  /** 报文自身 Message-ID（可能是空串）。 */
  messageId: string
  /** 直接父邮件的 Message-ID。 */
  inReplyTo: string | undefined
  /** 线程链（就近优先，已归一化为数组）。 */
  references: string[]
  /** 发件人邮箱（小写）。 */
  fromAddress: string
  /** 发件人显示名。 */
  fromName: string
  /** 收件人邮箱列表。 */
  to: string[]
  /** 已解码的主题（mailparser 负责 RFC2047 解码）。 */
  subject: string
  /** 发送时间（ISO 字符串）。 */
  date: string | undefined
  /** 纯文本正文（无 text/plain 时由 HTML 降级而来）。 */
  text: string
  /** 附件概要。 */
  attachments: MailAttachment[]
  /** 是否为自动回复/自动生成信件（RFC 3834 Auto-Submitted != no）。 */
  autoSubmitted: boolean
}

/** 把 mailparser 的地址字段（可能是单个对象或数组）拍平成地址列表。 */
function flattenAddresses(field: AddressObject | AddressObject[] | undefined): { address: string; name: string }[] {
  if (field === undefined) return []
  const objects = Array.isArray(field) ? field : [field]
  const out: { address: string; name: string }[] = []
  for (const object of objects) {
    for (const entry of object.value) {
      out.push({ address: (entry.address ?? '').trim().toLowerCase(), name: (entry.name ?? '').trim() })
    }
  }
  return out
}

/** 归一化 References：mailparser 可能给出字符串或数组。 */
function normalizeReferences(field: string | string[] | undefined): string[] {
  if (field === undefined) return []
  const list = Array.isArray(field) ? field : field.split(/\s+/)
  return list.map(item => item.trim()).filter(item => item.length > 0)
}

/**
 * 解析一封原始邮件报文。
 * @param uid - 该邮件在邮箱中的 UID。
 * @param source - 原始报文内容。
 */
export async function parseMail(uid: number, source: Buffer | string): Promise<ParsedMail> {
  const parsed = await simpleParser(source)
  const senders = flattenAddresses(parsed.from)
  const primary = senders[0]
  const recipients = flattenAddresses(parsed.to).map(item => item.address)
  // RFC 3834：自动回复方必须置 Auto-Submitted: auto-replied，接收方不得再自动回复它。
  // 我们据此识别「自动回复」，避免自动回信再触发自动回信形成无限环路（见 AGENTS.md）。
  const autoSubmittedRaw = parsed.headers.get('auto-submitted')
  const autoSubmitted = typeof autoSubmittedRaw === 'string'
    && autoSubmittedRaw.trim().toLowerCase() !== 'no'
  const text = (parsed.text ?? '').trim()
  return {
    uid,
    messageId: (parsed.messageId ?? '').trim(),
    inReplyTo: parsed.inReplyTo === undefined ? undefined : parsed.inReplyTo.trim(),
    references: normalizeReferences(parsed.references),
    fromAddress: primary?.address ?? '',
    fromName: primary?.name ?? '',
    to: recipients,
    subject: (parsed.subject ?? '').trim(),
    date: parsed.date === undefined ? undefined : parsed.date.toISOString(),
    // 只有 HTML 时退化为去标签文本，保证模型一定能读到内容
    text: text.length > 0 ? text : htmlFallback(parsed.html),
    autoSubmitted,
    attachments: (parsed.attachments ?? []).map(item => ({
      filename: item.filename ?? '(未命名)',
      size: item.size ?? 0,
      contentType: item.contentType ?? 'application/octet-stream',
    })),
  }
}

/**
 * HTML 正文降级：仅供「邮件只有 HTML 没有纯文本」时兜底。
 * 块级标签折算换行，解码常见实体，收敛空行。
 * @param html - mailparser 给出的 HTML（可能是 false / undefined）。
 */
export function htmlFallback(html: string | false | undefined): string {
  if (html === false || html === undefined) return ''
  return html
    .replace(/<\/?(?:br|p|div|tr|li|h[1-6]|table|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

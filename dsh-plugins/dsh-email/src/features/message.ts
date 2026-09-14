/**
 * 邮件内容组装砖块：把工具入参规范化为可直接发送的邮件结构。
 *
 * 纯计算——不读附件文件、不发网络（附件真实性与体积由 smtp.ts 校验），
 * 因此可以在毫秒级单测里覆盖全部规则分支。
 *
 * @module @deepseek-ai/dsh-email/features/message
 */

import { resolve as resolvePath } from 'node:path'
import { parseAddresses } from './address'

/** 单个邮件附件数量上限：防止一次误传整个目录导致邮件服务器直接拒信。 */
export const MAX_ATTACHMENTS = 10

/** 组装前的原始输入（全部来自工具参数，可能缺省或为空串）。 */
export interface MailInput {
  subject?: string | undefined
  body?: string | undefined
  html?: string | undefined
  cc?: string | undefined
  attachments?: readonly string[] | undefined
}

/** 组装完成、可直接投递给 SMTP 的邮件内容。 */
export interface CompiledMail {
  subject: string
  text: string
  html?: string
  cc: string[]
  attachments: string[]
}

/** 组装结果：成功给出邮件内容，失败给出中文可操作原因。 */
export type CompileResult = { ok: true; mail: CompiledMail } | { ok: false; error: string }

/** 块级标签换行规则：这些标签闭合处插入换行，避免正文被压成一整行。 */
const BLOCK_BOUNDARY = /<\/?(?:br|p|div|tr|li|h[1-6]|table|section|article)\b[^>]*>/gi

/** 实体解码表：只覆盖邮件正文里最常见的几种，够用且无依赖。 */
const ENTITIES: Readonly<Record<string, string>> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

/**
 * 把 HTML 正文降级为纯文本，作为 multipart/alternative 的文本分支提升送达率。
 *
 * 转换规则（尽力而为，不追求完整解析）：
 *   1. 块级标签（p/div/br/li/tr/h1-h6 等）的开合都折算为换行，
 *      于是相邻段落之间自然留出空行——这是 HTML→纯文本的通行语义；
 *   2. 其余标签直接去除，行内标签（strong/span 等）不产生换行；
 *   3. 解码常见实体，收敛连续空行。
 * @param html - 原始 HTML 片段。
 */
export function htmlToPlainText(html: string): string {
  const withBreaks = html.replace(BLOCK_BOUNDARY, '\n')
  const stripped = withBreaks.replace(/<[^>]*>/g, '')
  const decoded = stripped.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, match => ENTITIES[match] ?? match)
  return decoded
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 规范化附件路径：去空白、剔除空项、按绝对路径去重。
 * 这里只做字符串层面的归一，不判断文件是否存在——那是 IO，归 smtp.ts。
 * @param attachments - 原始附件路径列表。
 */
export function normalizeAttachments(attachments: readonly string[]): string[] {
  const resolved: string[] = []
  const seen = new Set<string>()
  for (const raw of attachments) {
    const candidate = raw.trim()
    if (candidate.length === 0) continue
    const absolute = resolvePath(candidate)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    resolved.push(absolute)
  }
  return resolved
}

/**
 * 校验并组装邮件内容。
 *
 * 主题必填；正文要求 body 与 html 至少有一个；只给 html 时自动生成纯文本分支；
 * 抄送地址沿用与收件人同一套解析规则，非法即拒绝而非静默丢弃。
 *
 * @param input - 工具参数形态的原始输入。
 * @returns 组装结果。
 */
export function compileMail(input: MailInput): CompileResult {
  const subject = (input.subject ?? '').trim()
  if (subject.length === 0) return { ok: false, error: '邮件主题（subject）不能为空' }

  const body = (input.body ?? '').trim()
  const html = (input.html ?? '').trim()
  if (body.length === 0 && html.length === 0) {
    return { ok: false, error: '邮件正文不能为空：请提供 body（纯文本）或 html（富文本）' }
  }
  const text = body.length > 0 ? body : htmlToPlainText(html)

  const cc = parseAddresses(input.cc)
  if (cc.invalid.length > 0) {
    return { ok: false, error: `抄送邮箱格式不合法：${cc.invalid.join('、')}` }
  }

  const attachments = normalizeAttachments(input.attachments ?? [])
  if (attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `附件数量超过上限 ${MAX_ATTACHMENTS}（当前 ${attachments.length} 个）` }
  }

  return {
    ok: true,
    mail: {
      subject,
      text,
      ...(html.length > 0 ? { html } : {}),
      cc: cc.addresses,
      attachments,
    },
  }
}

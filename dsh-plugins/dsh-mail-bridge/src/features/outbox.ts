/**
 * 回信砖块：把「回复」这层语义拼成邮件头再交给 SMTP 发出。
 *
 * 与 dsh-email 插件的分工：dsh-email 是通用发信能力（谁都能用、无状态）；
 * 本砖块服务于「线程镜像」——它必须带上 In-Reply-To / References 与统一的
 * 主题标签，让同一会话的往来在邮箱里始终是同一条线程。职责不同，故各自持有
 * 自己的传输封装，不跨插件调用。
 *
 * @module @deepseek-ai/dsh-mail-bridge/features/outbox
 */

import { createTransport } from 'nodemailer'

/** SMTP 发送设置。 */
export interface SmtpSettings {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  fromName: string
  timeoutMs: number
}

/** 一封「回复」邮件的内容。 */
export interface OutgoingReply {
  /** 收件人（对端或主人）。 */
  to: readonly string[]
  /** 已拼好的主题（含 Re: 与会话标签）。 */
  subject: string
  /** 纯文本正文。 */
  text: string
  /** 被回复邮件的 Message-ID。 */
  inReplyTo?: string
  /** 累积的线程链。 */
  references: readonly string[]
  /** 本地附件绝对路径（可选）。 */
  attachments?: readonly string[]
}

/** 发送结果。 */
export type SendOutcome =
  | { ok: true; messageId: string; response: string }
  | { ok: false; error: string; hint?: string }

/** nodemailer 错误的可读字段。 */
interface SmtpErrorShape {
  code?: unknown
  response?: unknown
  message?: unknown
}

/** 从任意异常里取出可读字段。 */
function asSmtpError(error: unknown): SmtpErrorShape {
  if (typeof error === 'object' && error !== null) return error as SmtpErrorShape
  return { message: error }
}

/** 取字符串字段（非字符串得到空串）。 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 把 SMTP 失败翻译成中文可操作信息。
 * @param error - 捕获到的异常。
 */
export function describeSmtpError(error: unknown): { error: string; hint?: string } {
  const shape = asSmtpError(error)
  const code = readString(shape.code)
  const response = readString(shape.response).replace(/\s+/g, ' ').trim()
  const detail = response.length > 0 ? `，服务器响应：${response}` : ''

  if (code === 'EAUTH') {
    return {
      error: `QQ 邮箱认证失败：授权码被拒绝${detail}`,
      hint: '登录 QQ 邮箱 → 设置 → 账号 → 重新生成 SMTP 授权码并更新插件配置',
    }
  }
  if (code === 'EENVELOPE') {
    return { error: `收件人被邮件服务器拒绝${detail}`, hint: '确认收件人地址拼写正确' }
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET') {
    return { error: `无法连接 SMTP 服务器${detail}`, hint: '确认本机可访问 smtp.qq.com:465（SSL）' }
  }
  const message = readString(shape.message)
  return { error: `发送邮件失败${message.length > 0 ? `：${message}` : ''}` }
}

/**
 * 发出一封「回复」。
 * @param settings - SMTP 设置。
 * @param reply - 回复内容（已含线程头）。
 */
export async function sendReply(settings: SmtpSettings, reply: OutgoingReply): Promise<SendOutcome> {
  if (settings.user.trim().length === 0 || settings.pass.trim().length === 0) {
    return { ok: false, error: 'SMTP 发件凭证未配置（user / authCode）' }
  }
  if (reply.to.length === 0) return { ok: false, error: '收件人不能为空' }

  const transporter = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.pass },
    connectionTimeout: settings.timeoutMs,
    greetingTimeout: settings.timeoutMs,
    socketTimeout: settings.timeoutMs,
    tls: { servername: settings.host },
  })
  try {
    const info: { messageId?: unknown; response?: unknown } = await transporter.sendMail({
      from: { name: settings.fromName, address: settings.user },
      to: [...reply.to],
      subject: reply.subject,
      text: reply.text,
      // 线程语义：In-Reply-To 指向被回复的那封，References 累积整条链，
      // 这两项是邮件客户端把往来并成一条对话线程的依据。
      ...(reply.inReplyTo !== undefined && reply.inReplyTo.length > 0 ? { inReplyTo: reply.inReplyTo } : {}),
      ...(reply.references.length > 0 ? { references: [...reply.references] } : {}),
      ...(reply.attachments !== undefined && reply.attachments.length > 0
        ? { attachments: reply.attachments.map(path => ({ path })) }
        : {}),
    })
    return {
      ok: true,
      messageId: readString(info.messageId),
      response: readString(info.response),
    }
  } catch (error) {
    return { ok: false, ...describeSmtpError(error) }
  } finally {
    transporter.close()
  }
}

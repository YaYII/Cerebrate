/**
 * QQ 邮箱 SMTP 发送砖块：本插件唯一发起网络的模块。
 *
 * 为什么用 nodemailer：MIME 组装（RFC 2047 中文主题编码、附件分段、点填充）
 * 与 SSL 握手细节出错代价高，复用成熟实现；它在构建期被内联进 lib/index.js，
 * 因此部署侧依旧是「单文件、零 node_modules」，与同仓库其他插件保持一致。
 *
 * 本模块的另一条铁律：任何失败都归一化为中文可操作信息（ok:false + 原因 +
 * 处置建议），绝不把 stack 抛给模型。
 *
 * @module @deepseek-ai/dsh-email/features/smtp
 */

import { statSync } from 'node:fs'
import { createTransport } from 'nodemailer'

/** SMTP 连接与发件人设置。 */
export interface SmtpSettings {
  /** SMTP 服务器主机名，QQ 邮箱为 smtp.qq.com。 */
  host: string
  /** SMTP 端口，SSL 为 465。 */
  port: number
  /** 是否使用隐式 SSL（QQ 邮箱 465 端口为 true）。 */
  secure: boolean
  /** 发件邮箱账号。 */
  user: string
  /** SMTP 授权码（不是登录密码）。 */
  pass: string
  /** 发件人显示名。 */
  fromName: string
  /** 连接/握手/socket 超时（毫秒）。 */
  timeoutMs: number
  /** 单个附件体积上限（字节）。 */
  maxAttachmentBytes: number
}

/** 待发送的邮件内容。 */
export interface SmtpMessage {
  to: readonly string[]
  cc: readonly string[]
  subject: string
  text: string
  html?: string
  attachments: readonly string[]
}

/** 发送结果：成功给投递回执，失败给中文原因与处置建议。 */
export type SendResult =
  | {
    ok: true
    messageId: string
    accepted: string[]
    rejected: string[]
    response: string
  }
  | { ok: false; error: string; hint?: string }

/** nodemailer sendMail 回执中我们真正用到的字段。 */
interface SentInfo {
  messageId?: unknown
  accepted?: unknown
  rejected?: unknown
  response?: unknown
}

/** nodemailer 抛出的错误中我们用来分类的字段。 */
interface SmtpErrorShape {
  code?: unknown
  command?: unknown
  responseCode?: unknown
  response?: unknown
  message?: unknown
}

/**
 * 把未知错误收窄为可读的字段集合。
 * 只做字段提取，不做类型体操——错误分类靠下面的 describeSmtpError。
 * @param error - 捕获到的任意异常。
 */
function asSmtpError(error: unknown): SmtpErrorShape {
  if (typeof error === 'object' && error !== null) return error as SmtpErrorShape
  return { message: error }
}

/** 取字符串字段，非字符串一律得到空串。 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 把回执中的地址字段（可能是数组，也可能是单个值）规范为字符串数组。 */
function readAddressList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item))
  return []
}

/**
 * 把 SMTP 失败翻译成中文可操作信息。
 *
 * 分类依据 nodemailer 的 error.code（EAUTH/ECONNECTION/ETIMEDOUT/ESOCKET/
 * EENVELOPE 等）与 responseCode（550/553/554），这些才是可据以处置的证据。
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
      hint: '登录 QQ 邮箱 → 设置 → 账号 → 开启 SMTP 服务后重新生成授权码，更新插件配置的 authCode 字段',
    }
  }
  if (code === 'EENVELOPE') {
    return {
      error: `收件人被邮件服务器拒绝${detail}`,
      hint: '确认收件人地址拼写正确，且未被对方的收信限制策略拦截',
    }
  }
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ETIMEDOUT' || code === 'EDNS') {
    return {
      error: `无法连接 QQ 邮箱 SMTP 服务器${detail}`,
      hint: '确认本机可访问 smtp.qq.com:465（SSL），以及网络/防火墙未拦截出站 465 端口',
    }
  }
  if (code === 'EMESSAGE') {
    return { error: `邮件内容被服务器拒绝${detail}` }
  }

  const responseCode = typeof shape.responseCode === 'number' ? shape.responseCode : 0
  if (responseCode === 550 || responseCode === 553 || responseCode === 554 || responseCode === 535) {
    return {
      error: `邮件服务器拒绝本次投递（响应码 ${responseCode}）${detail}`,
      hint: responseCode === 535
        ? '535 通常是认证失败或发件账号未被 SMTP 服务放行，请核对发件邮箱与授权码是否匹配'
        : '内容或收件人被拒，请检查收件人地址与邮件内容',
    }
  }

  const message = readString(shape.message)
  return { error: `发送邮件失败${message.length > 0 ? `：${message}` : ''}` }
}

/** 校验 SMTP 与发件人配置，返回 undefined 表示配置可用。 */
function checkSettings(settings: SmtpSettings): string | undefined {
  if (settings.host.trim().length === 0) return 'SMTP 服务器地址（smtpHost）未配置'
  if (settings.user.trim().length === 0 || !settings.user.includes('@')) {
    return '发件邮箱（sender）未配置或不是合法邮箱'
  }
  if (settings.pass.trim().length === 0) {
    return 'SMTP 授权码（authCode）未配置：请在插件配置中填入 QQ 邮箱授权码'
  }
  return undefined
}

/**
 * 校验附件：必须存在、是普通文件、且不超过单附件体积上限。
 * 附件是本插件唯一读取本地文件的入口，因此体积与存在性在这里一次判清。
 */
function checkAttachments(attachments: readonly string[], maxBytes: number): string | undefined {
  for (const path of attachments) {
    let size = 0
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return `附件不是普通文件：${path}`
      size = stat.size
    } catch {
      return `附件不存在或不可读：${path}`
    }
    if (size > maxBytes) {
      const limitMb = Math.round(maxBytes / 1024 / 1024)
      return `附件超过单文件上限 ${limitMb} MB：${path}（${(size / 1024 / 1024).toFixed(1)} MB）`
    }
  }
  return undefined
}

/**
 * 通过 SMTP 发送一封邮件。
 *
 * 每次调用新建并关闭连接（不使用连接池）：发信是低频动作，短连接更省心，
 * 也不会在进程里留下长期持有的 socket。
 *
 * @param settings - SMTP 与发件人设置。
 * @param message - 已完成组装与校验的邮件内容。
 */
export async function sendMail(settings: SmtpSettings, message: SmtpMessage): Promise<SendResult> {
  const settingsError = checkSettings(settings)
  if (settingsError !== undefined) return { ok: false, error: settingsError }

  const attachmentError = checkAttachments(message.attachments, settings.maxAttachmentBytes)
  if (attachmentError !== undefined) return { ok: false, error: attachmentError }

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
    const info: SentInfo = await transporter.sendMail({
      from: { name: settings.fromName, address: settings.user },
      to: [...message.to],
      ...(message.cc.length > 0 ? { cc: [...message.cc] } : {}),
      subject: message.subject,
      text: message.text,
      ...(message.html !== undefined ? { html: message.html } : {}),
      attachments: message.attachments.map(path => ({ path })),
    })
    return {
      ok: true,
      messageId: readString(info.messageId),
      accepted: readAddressList(info.accepted),
      rejected: readAddressList(info.rejected),
      response: readString(info.response),
    }
  } catch (error) {
    return { ok: false, ...describeSmtpError(error) }
  } finally {
    transporter.close()
  }
}

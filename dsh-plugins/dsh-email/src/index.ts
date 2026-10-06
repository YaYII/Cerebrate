/**
 * DeepSeek Harness 的邮件发送插件（QQ 邮箱 SMTP）。
 *
 * 解决的问题：每次要发邮件时，模型都反问用户「邮箱账号是什么、授权码是什么、
 * 发给谁」。本插件把发件凭证与默认收件人固化进配置，并注册一个开箱即用的
 * `email_send` 工具——模型只需给出主题与正文即可发信；用户临时给了新收件人，
 * 就把新地址传进 `to`，没给则自动回退默认收件人。
 *
 * 架构分层：本文件是装配层（工具注册 + 引导注入 + 配置契约）；能力在
 * features/（address 地址解析、message 内容组装、smtp 网络发送）。
 *
 * @module @deepseek-ai/dsh-email
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveRecipients } from './features/address'
import { compileMail, MAX_ATTACHMENTS } from './features/message'
import { sendMail } from './features/smtp'
import type { SmtpSettings } from './features/smtp'

/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
export const name = 'dsh-email'
export const inject = ['tools']

/** 插件配置：发件凭证与默认收件人都固化在这里，模型无需每次询问用户。 */
export interface Config {
  /** SMTP 服务器主机名。 */
  smtpHost: string
  /** SMTP 端口（QQ 邮箱 SSL 为 465）。 */
  smtpPort: number
  /** 是否使用隐式 SSL。 */
  smtpSecure: boolean
  /** 发件邮箱账号。 */
  sender: string
  /** SMTP 授权码（QQ 邮箱「设置 → 账号」生成，不是登录密码）。 */
  authCode: string
  /** 发件人显示名。 */
  senderName: string
  /** 默认收件人：调用方未指定收件人时使用。 */
  defaultRecipient: string
  /** 连接/握手/socket 超时（毫秒）。 */
  timeoutMs: number
  /** 单个附件体积上限（字节，默认 25 MB）。 */
  maxAttachmentBytes: number
  /** 是否在首个 step 注入发信引导。 */
  injectGuidance: boolean
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  smtpHost: z.string().default('smtp.qq.com'),
  smtpPort: z.number().default(465),
  smtpSecure: z.boolean().default(true),
  sender: z.string().default(''),
  authCode: z.string().default(''),
  senderName: z.string().default('DSH 邮件助手'),
  defaultRecipient: z.string().default(''),
  timeoutMs: z.number().default(20000),
  maxAttachmentBytes: z.number().default(25 * 1024 * 1024),
  injectGuidance: z.boolean().default(true),
})

/** 本包注入消息的来源插件标签。 */
const PRODUCER_KIND = 'dsh-email'

/** 本包注入消息的生产者 kind（producer-owned source）。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-email': { kind: 'dsh-email'; form?: 'instructions' }
  }
}

/** 旧版 V3 会话消息迁移后的 kind；识别它以免升级后的会话重复注入。 */
const MIGRATED_PRODUCER_KIND = `plugin:${PRODUCER_KIND}`

/** 从工具参数中取字符串：非字符串或缺失一律得到空串。 */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 从工具参数中取字符串数组：非数组得到空数组，元素统一转字符串。 */
function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : []
}

/** 把插件配置映射为 SMTP 发送设置（契约与实现分离）。 */
function toSmtpSettings(config: Config): SmtpSettings {
  return {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    user: config.sender,
    pass: config.authCode,
    fromName: config.senderName,
    timeoutMs: config.timeoutMs,
    maxAttachmentBytes: config.maxAttachmentBytes,
  }
}

/** 折叠进首个 agent step 的发信引导，让模型不必再向用户索要邮箱信息。 */
function buildGuidance(config: Config): string {
  const defaultLine = config.defaultRecipient.length > 0
    ? `- 默认收件人：${config.defaultRecipient}。用户没给收件人时省略 to；用户给了新地址就把新地址传给 to（多个用英文逗号分隔）。`
    : '- 本插件未配置默认收件人：用户未指定收件人时，必须先问清收件人地址再发信。'
  return [
    '【邮件发送】本会话具备 dsh-email 插件能力：',
    `- 工具 email_send(to?, subject, body, html?, cc?, attachments?)：通过 QQ 邮箱（${config.sender}）发送邮件，SMTP 凭证已内置，无需向用户索要账号或授权码。`,
    defaultLine,
    '- 不要询问用户的邮箱密码/授权码，也不要为默认收件人反复确认；用户未要求时不要抄送其他人。',
    `- 附件传本地文件绝对路径数组（最多 ${MAX_ATTACHMENTS} 个），适合把生成的报告/文档直接邮件发出。`,
  ].join('\n')
}

/** 引导消息是否已存在于会话可见面。 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') return false
    const kind: string = event.data.source.kind
    return kind === PRODUCER_KIND || kind === MIGRATED_PRODUCER_KIND
  })
}

/** 把工具返回值以美化 JSON 文本呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 工具调用展示卡片。 */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/**
 * 注册 `email_send` 工具，并按配置注入发信引导。
 * @param ctx - 携带工具注册表的注册上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  // 1) 注册 email_send 工具：解析收件人 → 组装内容 → SMTP 发送，层层拿到中文可操作错误。
  const tools = {
    send: defineTool({
      name: 'email_send',
      description: `发送邮件：通过 QQ 邮箱（${config.sender}）把消息发给收件人。省略 to 时使用默认收件人${config.defaultRecipient.length > 0 ? `（${config.defaultRecipient}）` : ''}；用户提供了新地址就传 to。SMTP 凭证已内置，无需向用户索取。`,
      parameters: {
        to: {
          type: 'string',
          description: `收件人邮箱，多个用英文逗号分隔；省略则使用默认收件人${config.defaultRecipient.length > 0 ? `（${config.defaultRecipient}）` : ''}`,
        },
        subject: { type: 'string', description: '邮件主题', required: true },
        body: { type: 'string', description: '邮件正文（纯文本）；与 html 至少提供一个' },
        html: { type: 'string', description: '邮件正文（HTML，可选）；提供后与 body 组成多部分邮件' },
        cc: { type: 'string', description: '抄送邮箱，多个用英文逗号分隔（可选）' },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: `附件本地绝对路径列表（可选，最多 ${MAX_ATTACHMENTS} 个）`,
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const recipient = resolveRecipients(readOptionalString(args.to), config.defaultRecipient)
        if (!recipient.ok) return { ok: false, error: recipient.error }

        const compiled = compileMail({
          subject: readOptionalString(args.subject),
          body: readOptionalString(args.body),
          html: readOptionalString(args.html),
          cc: readOptionalString(args.cc),
          attachments: readStringArray(args.attachments),
        })
        if (!compiled.ok) return { ok: false, error: compiled.error }

        const outcome = await sendMail(toSmtpSettings(config), {
          to: recipient.recipients,
          cc: compiled.mail.cc,
          subject: compiled.mail.subject,
          text: compiled.mail.text,
          ...(compiled.mail.html !== undefined ? { html: compiled.mail.html } : {}),
          attachments: compiled.mail.attachments,
        })
        if (!outcome.ok) {
          return {
            ok: false,
            recipient: recipient.recipients,
            recipientSource: recipient.source,
            error: outcome.error,
            ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
          }
        }
        return {
          ok: true,
          recipient: recipient.recipients,
          recipientSource: recipient.source,
          cc: compiled.mail.cc,
          subject: compiled.mail.subject,
          attachments: compiled.mail.attachments,
          messageId: outcome.messageId,
          accepted: outcome.accepted,
          rejected: outcome.rejected,
          response: outcome.response,
        }
      },
      presentCall: args => presentCall('Send an email', args),
    }),
  }
  for (const tool of Object.values(tools)) ctx.tools.register(tool)

  // 2) 引导注入：仅当开启且尚未注入时，向会话表面追加一条插件来源说明。
  if (config.injectGuidance) {
    ctx.on('agent/pre-step', async (
      { agent, messages, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (guidanceAlreadyInjected(agent)) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text', text: buildGuidance(config) }],
        source: { kind: PRODUCER_KIND, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

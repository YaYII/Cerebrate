/**
 * 真实发信测试（默认跳过，绝不误发）。
 *
 * 启用方式（凭证只走环境变量，不写进源码）：
 *   DSH_EMAIL_LIVE=1 \
 *   DSH_EMAIL_LIVE_USER=xxx@qq.com \
 *   DSH_EMAIL_LIVE_CODE=<SMTP 授权码> \
 *   DSH_EMAIL_LIVE_TO=收件人@example.com \
 *   node node_modules/vitest/vitest.mjs run tests/live.spec.ts
 */
import { describe, expect, it } from 'vitest'
import { sendMail } from '../src/features/smtp'
import type { SmtpSettings } from '../src/features/smtp'

/** 是否开启真实发信。 */
const LIVE = process.env.DSH_EMAIL_LIVE === '1'

/** 从环境变量读取真实凭证。 */
function liveSettings(): SmtpSettings {
  return {
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: process.env.DSH_EMAIL_LIVE_USER ?? '',
    pass: process.env.DSH_EMAIL_LIVE_CODE ?? '',
    fromName: 'DSH 邮件助手',
    timeoutMs: 30000,
    maxAttachmentBytes: 25 * 1024 * 1024,
  }
}

describe.skipIf(!LIVE)('真实发信（需 DSH_EMAIL_LIVE=1）', () => {
  it('通过 QQ 邮箱 SMTP 成功投递一封测试邮件', async () => {
    const recipient = process.env.DSH_EMAIL_LIVE_TO ?? ''
    expect(recipient).not.toBe('')
    const result = await sendMail(liveSettings(), {
      to: [recipient],
      cc: [],
      subject: `dsh-email 真实发信自检 ${new Date().toISOString()}`,
      text: '这是一封由 dsh-email 插件发出的自检邮件，收到即代表 SMTP 链路可用。',
      attachments: [],
    })
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) expect(result.accepted.length).toBeGreaterThan(0)
  })
})

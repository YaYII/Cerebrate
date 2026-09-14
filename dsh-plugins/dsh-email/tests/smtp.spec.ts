/**
 * SMTP 发送砖块的离线单元测试：错误翻译与「发送前的本地拦截」。
 * 本文件绝不发起真实网络请求——所有用例都在构造阶段就被拒绝。
 */
import { describe, expect, it } from 'vitest'
import { describeSmtpError, sendMail } from '../src/features/smtp'
import type { SmtpSettings } from '../src/features/smtp'

/** 一套可用配置，供各用例按需覆盖字段。 */
function settings(patch: Partial<SmtpSettings> = {}): SmtpSettings {
  return {
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: 'sender@qq.com',
    pass: 'auth-code',
    fromName: 'DSH 邮件助手',
    timeoutMs: 20000,
    maxAttachmentBytes: 25 * 1024 * 1024,
    ...patch,
  }
}

describe('describeSmtpError 错误翻译', () => {
  it('认证失败给出授权码处置建议', () => {
    const result = describeSmtpError({ code: 'EAUTH', response: '535 Login Fail' })
    expect(result.error).toContain('认证失败')
    expect(result.hint).toContain('授权码')
  })

  it('连接失败指向 smtp.qq.com:465', () => {
    const result = describeSmtpError({ code: 'ETIMEDOUT' })
    expect(result.error).toContain('无法连接')
    expect(result.hint).toContain('465')
  })

  it('收件人被拒时提示核对地址', () => {
    const result = describeSmtpError({ code: 'EENVELOPE', response: '550 invalid recipient' })
    expect(result.error).toContain('收件人被邮件服务器拒绝')
    expect(result.hint).toContain('收件人地址')
  })

  it('按响应码 535 归类为投递被拒', () => {
    const result = describeSmtpError({ responseCode: 535 })
    expect(result.error).toContain('响应码 535')
  })

  it('未知错误至少给出原始信息', () => {
    expect(describeSmtpError(new Error('boom')).error).toBe('发送邮件失败：boom')
    expect(describeSmtpError('字符串异常').error).toBe('发送邮件失败：字符串异常')
  })
})

describe('sendMail 发送前的本地拦截（不联网）', () => {
  it('发件邮箱未配置时拒绝', async () => {
    const result = await sendMail(settings({ user: '' }), {
      to: ['a@b.com'], cc: [], subject: '标题', text: '正文', attachments: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('发件邮箱')
  })

  it('授权码未配置时拒绝', async () => {
    const result = await sendMail(settings({ pass: '  ' }), {
      to: ['a@b.com'], cc: [], subject: '标题', text: '正文', attachments: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('授权码')
  })

  it('附件不存在时拒绝', async () => {
    const result = await sendMail(settings(), {
      to: ['a@b.com'], cc: [], subject: '标题', text: '正文',
      attachments: ['/tmp/dsh-email-不存在的附件.pdf'],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('附件不存在或不可读')
  })

  it('附件目录被拒绝（不是普通文件）', async () => {
    const result = await sendMail(settings(), {
      to: ['a@b.com'], cc: [], subject: '标题', text: '正文', attachments: ['/tmp'],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('不是普通文件')
  })
})

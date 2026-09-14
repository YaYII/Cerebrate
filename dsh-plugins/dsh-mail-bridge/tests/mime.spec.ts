/**
 * 邮件解析砖块测试：用 QQ 实际会发出的报文形态（RFC2047 编码主题、
 * 相邻 encoded-word、base64 正文、线程头）验证解析结果。
 */
import { describe, expect, it } from 'vitest'
import { htmlFallback, parseMail } from '../src/features/mime'
import { extractThreadTag } from '../src/features/thread'

/** 构造 RFC2047 编码字（B 编码）。 */
function encoded(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/**
 * 构造一封仿 QQ 报文的原始邮件。
 * 主题刻意拆成两个相邻 encoded-word —— 这是实测中 QQ 的真实行为，
 * 解码时若在相邻编码字之间插入空格就会得到错误结果。
 */
function rawMessage(options: { body?: string; subject?: string } = {}): string {
  const body = options.body ?? '这是正文内容。'
  const subject = options.subject ?? `${encoded('报价单确认')} ${encoded(' [#s7f3a]')}`
  return [
    `From: ${encoded('张三')} <ZhangSan@Example.com>`,
    'To: 475554053@qq.com',
    `Subject: ${subject}`,
    'Message-ID: <tencent_abc123@qq.com>',
    'In-Reply-To: <dsh-parent@qq.com>',
    'References: <dsh-parent@qq.com> <tencent_prev@qq.com>',
    'Date: Mon, 14 Sep 2026 12:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n')
}

describe('parseMail 报文解析', () => {
  it('解码相邻 encoded-word 主题（QQ 会这样拆分中文主题）', async () => {
    const mail = await parseMail(1, rawMessage())
    expect(mail.subject).toBe('报价单确认 [#s7f3a]')
    expect(extractThreadTag(mail.subject)).toBe('s7f3a')
  })

  it('解析发件人：地址转小写，显示名解码', async () => {
    const mail = await parseMail(1, rawMessage())
    expect(mail.fromAddress).toBe('zhangsan@example.com')
    expect(mail.fromName).toBe('张三')
  })

  it('解析线程头（回复路由的兜底依据）', async () => {
    const mail = await parseMail(7, rawMessage())
    expect(mail.uid).toBe(7)
    expect(mail.messageId).toBe('<tencent_abc123@qq.com>')
    expect(mail.inReplyTo).toBe('<dsh-parent@qq.com>')
    expect(mail.references).toEqual(['<dsh-parent@qq.com>', '<tencent_prev@qq.com>'])
  })

  it('解码 base64 正文', async () => {
    const mail = await parseMail(1, rawMessage({ body: '这是一段中文正文，含标点。' }))
    expect(mail.text).toBe('这是一段中文正文，含标点。')
  })

  it('只有 HTML 时降级为纯文本，保证模型一定读得到内容', async () => {
    const raw = [
      'From: a@b.com',
      'To: c@d.com',
      'Subject: 只有 HTML',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>第一段</p><p>第二段</p>',
    ].join('\r\n')
    const mail = await parseMail(2, raw)
    expect(mail.text).toBe('第一段\n\n第二段')
  })

  it('无主题与无 Message-ID 时不抛异常（容错真实世界的脏邮件）', async () => {
    const raw = ['From: a@b.com', 'To: c@d.com', '', 'body'].join('\r\n')
    const mail = await parseMail(3, raw)
    expect(mail.subject).toBe('')
    expect(mail.messageId).toBe('')
    expect(mail.text).toBe('body')
  })
})

describe('htmlFallback 降级', () => {
  it('块级标签折算空行并解码实体', () => {
    expect(htmlFallback('<div>甲&amp;乙</div><div>丙</div>')).toBe('甲&乙\n\n丙')
  })

  it('false / undefined 得到空串', () => {
    expect(htmlFallback(false)).toBe('')
    expect(htmlFallback(undefined)).toBe('')
  })
})

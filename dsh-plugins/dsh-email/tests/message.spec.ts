/**
 * 邮件内容组装砖块的单元测试：主题/正文/抄送/附件的全部规则分支。
 */
import { describe, expect, it } from 'vitest'
import { resolve as resolvePath } from 'node:path'
import { compileMail, htmlToPlainText, MAX_ATTACHMENTS, normalizeAttachments } from '../src/features/message'

describe('htmlToPlainText HTML 降级', () => {
  it('块级标签折算为空行分隔并去除行内标签', () => {
    // 段落之间留空行是 HTML→纯文本的通行语义，便于纯文本客户端阅读
    expect(htmlToPlainText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n\n第二段')
  })

  it('行内标签不产生换行', () => {
    expect(htmlToPlainText('<p>你好 <strong>世界</strong></p>')).toBe('你好 世界')
  })

  it('解码常见实体', () => {
    expect(htmlToPlainText('<p>a&nbsp;&amp;&nbsp;b</p>')).toBe('a & b')
  })

  it('收敛多余空行', () => {
    expect(htmlToPlainText('<div>a</div><br><br><br><div>b</div>')).toBe('a\n\nb')
  })
})

describe('normalizeAttachments 附件路径归一', () => {
  it('转为绝对路径并去重', () => {
    const result = normalizeAttachments(['/tmp/a.pdf', '/tmp/a.pdf', ' /tmp/b.pdf '])
    expect(result).toEqual(['/tmp/a.pdf', '/tmp/b.pdf'])
  })

  it('相对路径按工作目录展开', () => {
    const result = normalizeAttachments(['report.md'])
    expect(result).toEqual([resolvePath('report.md')])
  })

  it('剔除空项', () => {
    expect(normalizeAttachments(['', '  '])).toEqual([])
  })
})

describe('compileMail 内容组装', () => {
  it('主题为空时拒绝', () => {
    const result = compileMail({ subject: '  ', body: '正文' })
    expect(result).toEqual({ ok: false, error: '邮件主题（subject）不能为空' })
  })

  it('正文与 HTML 都为空时拒绝', () => {
    const result = compileMail({ subject: '标题' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('邮件正文不能为空')
  })

  it('只给纯文本时组装成功且不带 html 字段', () => {
    const result = compileMail({ subject: '标题', body: '正文' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mail.text).toBe('正文')
      expect('html' in result.mail).toBe(false)
      expect(result.mail.cc).toEqual([])
    }
  })

  it('只给 HTML 时自动补纯文本分支', () => {
    const result = compileMail({ subject: '标题', html: '<p>富文本</p>' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mail.html).toBe('<p>富文本</p>')
      expect(result.mail.text).toBe('富文本')
    }
  })

  it('抄送地址非法时拒绝', () => {
    const result = compileMail({ subject: '标题', body: '正文', cc: '坏地址' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('抄送邮箱格式不合法')
  })

  it('抄送地址合法时保留', () => {
    const result = compileMail({ subject: '标题', body: '正文', cc: 'cc1@x.com, cc2@y.com' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mail.cc).toEqual(['cc1@x.com', 'cc2@y.com'])
  })

  it('附件数量超过上限时拒绝', () => {
    const tooMany = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_item, index) => `/tmp/${index}.pdf`)
    const result = compileMail({ subject: '标题', body: '正文', attachments: tooMany })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('附件数量超过上限')
  })
})

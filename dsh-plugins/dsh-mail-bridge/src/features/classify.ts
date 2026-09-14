/**
 * 陌生来信识别砖块：判断一封非白名单、非线程的来信是广告还是正事。
 *
 * 用户要求：「如果是广告，那就不用回复，如果是标识的内容，那就可以进行回复」。
 * 因此这里先做**规则预筛**（明显广告直接拦掉，不浪费一次模型调用），
 * 预筛放行的再交给宿主模型判断。提示词与结果解析都是纯函数，可单测。
 *
 * @module @deepseek-ai/dsh-mail-bridge/features/classify
 */

/** 明显广告/垃圾邮件的特征词。 */
const SPAM_HINTS: readonly RegExp[] = [
  /退订|取消订阅/i,
  /unsubscribe/i,
  /代开|开票|发票|税点/i,
  /促销|限时|秒杀|折扣|优惠券|满减/i,
  /贷款|博彩|彩票|棋牌|赌/i,
  /虚拟币|usdt|炒币|投资群|荐股|理财课/i,
  /中奖|抽奖|免费领|点击领取/i,
  /代发|群发|推广合作/i,
]

/** 机器发件人前缀（这些地址的来信通常是通知而非可对话内容）。 */
const ROBOT_SENDER = /^(no-?reply|do-?not-?reply|noreply|mailer-daemon|postmaster|notifications?|bounce)/i

/** 判定所需的来信摘要。 */
export interface ClassifyInput {
  fromAddress: string
  subject: string
  text: string
}

/**
 * 规则预筛：明显是广告/垃圾/机器通知的来信直接判定，不调用模型。
 * @param mail - 来信摘要。
 */
export function isObviousSpam(mail: ClassifyInput): boolean {
  if (ROBOT_SENDER.test(mail.fromAddress)) return true
  // 主题与正文前 500 字足以覆盖广告特征，避免正文过长拖慢匹配
  const haystack = `${mail.subject}\n${mail.text.slice(0, 500)}`
  return SPAM_HINTS.some(pattern => pattern.test(haystack))
}

/**
 * 生成分类提示词：要求模型只回一个词，便于稳定解析。
 * @param mail - 来信摘要。
 */
export function classifyPrompt(mail: ClassifyInput): string {
  return [
    '你是一个邮件分诊器。判断下面这封陌生来信属于哪一类：',
    'SPAM = 广告、营销、垃圾邮件、自动通知、诈骗；',
    'MEANINGFUL = 真人对我们说的话，包含需要处理的请求、问题或信息。',
    '',
    `发件人：${mail.fromAddress}`,
    `主题：${mail.subject}`,
    '正文：',
    mail.text.slice(0, 2000),
    '',
    '只输出一个词：SPAM 或 MEANINGFUL。不要输出任何其他内容。',
  ].join('\n')
}

/** 分类结论。 */
export type MailVerdict = 'spam' | 'meaningful' | 'unknown'

/**
 * 解析模型回答。
 * @param answer - 模型输出的原始文本。
 */
export function interpretVerdict(answer: string): MailVerdict {
  const normalized = answer.trim().toUpperCase()
  if (normalized.includes('MEANINGFUL')) return 'meaningful'
  if (normalized.includes('SPAM')) return 'spam'
  return 'unknown'
}

/**
 * 邮件线程砖块：给每个会话一个邮件身份，并判定一封来信该进哪个会话。
 *
 * 为什么需要它（用户明确要求）：「每一个对话就是一个 session」——回信必须是
 * 上一封的**回复**（同一线程不断延续），而不是每轮甩一封新邮件；主人/对端
 * 回复任意一封，系统都要知道该唤醒哪个分身。
 *
 * 路由采取双保险（两条通路都经过实测验证）：
 *   主路由 = 主题里的 `[#会话标签]`：人类可见，转发也不易丢；
 *   兜底   = In-Reply-To / References 线程头查映射表：用户直接点「回复」时自动带上。
 *
 * 纯计算、无 IO，可毫秒级单测。
 *
 * @module @deepseek-ai/dsh-mail-bridge/features/thread
 */

/** 会话标签形态：主题里以 `[#xxxxxx]` 出现。 */
export const THREAD_TAG_PATTERN = /\[#([a-z0-9]{4,12})\]/i

/** 一封邮件的线程归属（持久化在 store 里）。 */
export interface ThreadBinding {
  /** 会话标签：邮件与 session 之间的路由键。 */
  tag: string
  /** 绑定的 DSH 会话 id。 */
  sessionId: string
  /** 对端邮箱（小写）。 */
  peer: string
  /** 主题基（不含 Re: 前缀与标签），回信时复用。 */
  subjectBase: string
  /** 线程末梢的真实 Message-ID：下一封回复它的依据。 */
  lastMessageId: string
  /** 累积的 References 链（标准线程语义）。 */
  references: string[]
  /** 创建时间（ISO）。 */
  createdAt: string
  /** 最近更新时间（ISO）。 */
  updatedAt: string
}

/** 路由判定依据的线程索引。 */
export interface ThreadLookup {
  /** 标签是否已绑定会话。 */
  hasTag(tag: string): boolean
  /** 由 Message-ID 反查会话标签（线程头兜底路由）。 */
  tagForMessageId(messageId: string): string | undefined
}

/** 路由结论类型。 */
export type RouteKind =
  | 'thread' // 命中已有线程 → 唤醒对应分身继续
  | 'owner-new' // 主人新指令且无线程 → 新建分身
  | 'trusted-new' // 已建立信任的对端但无线程
  | 'stranger' // 陌生发件人 → 先识别

/** 路由结论。 */
export interface RouteDecision {
  kind: RouteKind
  /** 命中的会话标签（仅 kind=thread 时有值）。 */
  tag?: string
  /** 人类可读的判定依据，写入日志便于追溯。 */
  reason: string
}

/** 解析邮件中的路由信息。 */
export interface RouteInput {
  from: string
  subject: string
  inReplyTo: string | undefined
  references: readonly string[]
}

/**
 * 从主题中提取会话标签。
 * @param subject - 原始主题（应为已解码的明文）。
 */
export function extractThreadTag(subject: string): string | undefined {
  const matched = subject.match(THREAD_TAG_PATTERN)
  return matched?.[1]?.toLowerCase()
}

/**
 * 归一化出「主题基」：去掉 Re:/Fwd: 等回复前缀与线程标签。
 * 为什么保留主题基：回信时要沿用同一主题，让邮件客户端把往来并成一条线程。
 * @param subject - 原始主题。
 */
export function subjectBase(subject: string): string {
  return subject
    .replace(/(?:re|fw|fwd)\s*[:：]/gi, ' ')
    .replace(/回复\s*[:：]/g, ' ')
    .replace(/转发\s*[:：]/g, ' ')
    .replace(THREAD_TAG_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 生成回信主题：`Re: <主题基> [#会话标签]`。
 * @param base - 主题基（或任意主题，函数内部会再归一化）。
 * @param tag - 会话标签。
 */
export function replySubject(base: string, tag: string): string {
  const clean = subjectBase(base)
  return clean.length > 0 ? `Re: ${clean} [#${tag}]` : `Re: [#${tag}]`
}

/**
 * 生成新的会话标签（6 位 base36）。
 * @param random - 随机源（默认真随机；单测可注入）。
 */
export function createThreadTag(random: () => number = Math.random): string {
  let tag = ''
  while (tag.length < 6) tag += Math.floor(random() * 36).toString(36)
  return tag.slice(0, 6)
}

/**
 * 判定一封来信的路由去向。
 *
 * 顺序即优先级：先按主题标签精确命中；再看线程头是否落在已知 Message-ID 上；
 * 都不命中时，才按信任级别决定「主人的新指令 / 信任对端的新话题 / 陌生人」。
 *
 * @param input - 来信的路由信息。
 * @param trust - 发件人的信任级别（由 trust.ts 判定）。
 * @param lookup - 线程索引。
 */
export function routeMessage(input: RouteInput, trust: string, lookup: ThreadLookup): RouteDecision {
  const tag = extractThreadTag(input.subject)
  if (tag !== undefined && lookup.hasTag(tag)) {
    return { kind: 'thread', tag, reason: `主题标签 [#${tag}] 命中已知会话` }
  }

  // 线程头兜底：In-Reply-To 优先，其后是 References 链（就近优先）
  const chain = [input.inReplyTo, ...input.references].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  for (const messageId of chain) {
    const hit = lookup.tagForMessageId(messageId)
    if (hit !== undefined && lookup.hasTag(hit)) {
      return { kind: 'thread', tag: hit, reason: `线程头 ${messageId} 命中会话 [#${hit}]` }
    }
  }

  const dangling = tag !== undefined ? `（主题含未知标签 [#${tag}]）` : ''
  if (trust === 'owner') {
    return { kind: 'owner-new', reason: `主人来信且未命中线程${dangling}，按新指令处理` }
  }
  if (trust === 'authorized' || trust === 'established') {
    return { kind: 'trusted-new', reason: `${trust} 对端来信但未命中线程${dangling}` }
  }
  return { kind: 'stranger', reason: `陌生发件人${dangling}` }
}

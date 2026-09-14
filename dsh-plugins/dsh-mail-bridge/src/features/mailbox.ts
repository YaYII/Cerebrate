/**
 * 邮箱连接砖块：本插件唯一发起 IMAP 网络的地方。
 *
 * 两件事：
 *   1. 常驻监听收件箱——imapflow 默认在连接空闲时自动进入 IDLE，
 *      新邮件到达会推 `exists` 事件（实测 QQ IMAP 支持 IDLE），
 *      因此不需要轮询；断线自动重连，重连后由装配层按 UID 水位补拉。
 *   2. 一次性读取任意邮箱（主要用于回读「已发送」）——用独立短连接，
 *      避免打断常驻监听的 IDLE。
 *
 * @module @deepseek-ai/dsh-mail-bridge/features/mailbox
 */

import { ImapFlow } from 'imapflow'

/** IMAP 连接配置。 */
export interface ImapConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  /** 收件箱目录名。 */
  inboxMailbox: string
  /** 已发送目录名（出站信任与线程末梢的回读来源）。 */
  sentMailbox: string
  /** 断线重连间隔（毫秒）。 */
  reconnectMs: number
}

/** 原始邮件（UID + 报文）。 */
export interface RawMessage {
  uid: number
  source: Buffer
}

/** 常驻监听的回调。 */
export interface ListenerCallbacks {
  /** 收到「有新邮件」的信号（装配层据此按水位拉取）。 */
  onNewMail(): void
  /** 连接状态变化（写日志用）。 */
  onStatus(message: string): void
  /** 连接或协议错误（不致命，会自动重连）。 */
  onError(error: Error): void
}

/** 休眠。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** 构造 imapflow 客户端（统一超时与 TLS 设置）。 */
function createClient(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    // QQ 服务器证书与主机名匹配，显式指定 SNI 避免某些网络环境下的握手歧义
    tls: { servername: config.host },
    // IDLE 期间也要能被 socket 超时保护，避免半开连接永久挂起
    socketTimeout: 10 * 60 * 1000,
    greetingTimeout: 30 * 1000,
    connectionTimeout: 30 * 1000,
  })
}

/**
 * 收件箱常驻监听器：连接 → 打开收件箱 → 等待推送 → 断线重连。
 * start() 立即返回，后台循环自行维持连接（不把异常抛给插件装配层）。
 */
export class InboxListener {
  readonly #config: ImapConfig
  readonly #callbacks: ListenerCallbacks
  #client: ImapFlow | undefined
  #stopped = true
  #notifyClosed: (() => void) | undefined

  constructor(config: ImapConfig, callbacks: ListenerCallbacks) {
    this.#config = config
    this.#callbacks = callbacks
  }

  /** 当前是否持有可用连接。 */
  isConnected(): boolean {
    return this.#client?.usable === true
  }

  /** 启动监听（幂等：重复调用不会建立第二条连接）。 */
  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    void this.#loop()
  }

  /** 停止监听并断开连接。 */
  async stop(): Promise<void> {
    this.#stopped = true
    const client = this.#client
    this.#client = undefined
    if (client !== undefined) {
      try { await client.logout() } catch { /* 已断开，忽略 */ }
    }
    this.#notifyClosed?.()
  }

  /** 后台维持循环：连接 → 阻塞至断开 → 退避 → 重连。 */
  async #loop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.#connectOnce()
      } catch (error) {
        this.#callbacks.onError(error instanceof Error ? error : new Error(String(error)))
      }
      if (this.#stopped) break
      this.#callbacks.onStatus(`IMAP 连接断开，${Math.round(this.#config.reconnectMs / 1000)} 秒后重连`)
      await sleep(this.#config.reconnectMs)
    }
  }

  /** 建立一次连接并阻塞到它断开。 */
  async #connectOnce(): Promise<void> {
    const client = createClient(this.#config)
    this.#client = client
    client.on('error', (error: unknown) => {
      this.#callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    })
    // 新邮件推送：只发信号，拉取与去重交给装配层（那里才知道 UID 水位）
    client.on('exists', () => { this.#callbacks.onNewMail() })
    const closed = new Promise<void>(resolve => { this.#notifyClosed = resolve })
    await client.connect()
    await client.mailboxOpen(this.#config.inboxMailbox)
    this.#callbacks.onStatus(`IMAP 已连接，正在监听「${this.#config.inboxMailbox}」（IDLE 推送）`)
    await closed
    this.#notifyClosed = undefined
  }

  /**
   * 读取当前收件箱的最大 UID，用于首次启动时对齐水位基线。
   *
   * 为什么需要它：UID 并非从 1 连续编号（本机实测邮箱 UID 已到 230+）。
   * 若首次启动时水位为 0，有界区间会固定落在 `1:fetchLimit` 这段不存在的
   * UID 上，新邮件永远落在区间之外——**水位再也不推进，新邮件永久漏收**。
   * 因此首启必须先把水位对齐到当前最大 UID：既不重放历史邮件，又能接住新邮件。
   */
  async currentMaxUid(): Promise<number> {
    const client = this.#client
    if (client === undefined || !client.usable) throw new Error('IMAP 连接不可用，稍后重试')
    const last = await client.fetchOne('*', { uid: true })
    // fetchOne 在邮箱为空时返回 false
    if (last === false) return 0
    return typeof last.uid === 'number' ? last.uid : 0
  }

  /**
   * 拉取 UID 大于水位的邮件。
   *
   * 两个刻意的实现选择（都是实测踩出来的）：
   *   1. 用**有界 UID 区间** `${from}:${to}` 而不是 `${from}:*` 再 break——
   *      中途 break 会遗留未被消费的 fetch 流，imapflow 会一直认为「连接忙」，
   *      从此不再武装 auto-IDLE，新邮件推送彻底失效；
   *   2. `N:*` 即使没有新邮件也**至少返回最后一封**，因此仍需按 `uid > sinceUid`
   *      过滤，否则会重复处理同一封。
   *
   * @param sinceUid - 已处理到的最大 UID（水位）。
   * @param limit - 单次最多取多少封。
   */
  async fetchSince(sinceUid: number, limit: number): Promise<RawMessage[]> {
    const client = this.#client
    if (client === undefined || !client.usable) throw new Error('IMAP 连接不可用，稍后重试')
    const from = sinceUid + 1
    const to = sinceUid + limit
    const collected: RawMessage[] = []
    for await (const message of client.fetch(`${from}:${to}`, { uid: true, source: true }, { uid: true })) {
      if (typeof message.uid !== 'number' || message.uid <= sinceUid) continue
      const source = message.source
      if (source === undefined) continue
      collected.push({ uid: message.uid, source })
    }
    return collected
  }
}

/**
 * 用一次性短连接读取指定邮箱的最近若干封邮件。
 * 为什么单独开连接：常驻监听连接正开着收件箱，频繁切换邮箱会打断 IDLE。
 *
 * 与 fetchSince 同理，这里也用**有界区间**遍历，绝不在 fetch 中途 break。
 *
 * @param config - IMAP 配置。
 * @param mailbox - 目标邮箱目录名。
 * @param limit - 取最近多少封。
 * @param sinceUid - 只取 UID 大于该值的邮件（0 表示按序号取最近 limit 封）。
 */
export async function readRecent(
  config: ImapConfig,
  mailbox: string,
  limit: number,
  sinceUid = 0,
): Promise<RawMessage[]> {
  const client = createClient(config)
  try {
    await client.connect()
    const box = await client.mailboxOpen(mailbox)
    if (box.exists === 0) return []
    // 未指定水位：按序号取最近 limit 封；指定水位：按 UID 区间取
    const range = sinceUid > 0
      ? `${sinceUid + 1}:${sinceUid + limit}`
      : `${Math.max(1, box.exists - limit + 1)}:${box.exists}`
    const collected: RawMessage[] = []
    for await (const message of client.fetch(range, { uid: true, source: true }, { uid: sinceUid > 0 })) {
      if (typeof message.uid !== 'number' || message.uid <= sinceUid) continue
      const source = message.source
      if (source === undefined) continue
      collected.push({ uid: message.uid, source })
    }
    return collected
  } finally {
    try { await client.logout() } catch { /* 已断开，忽略 */ }
  }
}

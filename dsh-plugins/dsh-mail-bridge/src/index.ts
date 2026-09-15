/**
 * DeepSeek Harness 的「邮件 ↔ 会话」桥插件。
 *
 * 解决的问题（用户原话归纳）：每一个对话就是一个 AI 分身；主人或对端回复某封
 * 邮件时，系统要凭邮件里自带的会话标识，**唤醒对应的那个分身**，让它带着自己的
 * 上下文继续，而不是把邮件丢给一个什么都不清楚的通用 agent。回信必须是**回复**
 * （同一邮件线程不断延续），而不是每轮甩一封新邮件。主人邮箱则是指挥中枢——
 * 数字员工是主人邮箱的延伸。
 *
 * 信任模型：不设传统白名单。主人邮箱最高权限；其次是配置数组里的授权地址；
 * 再其次是**出站建立信任**（我们主动发过邮件的对端，其回复即可触发）；
 * 其余按陌生处理——先识别，广告忽略，有意义的摘要上报主人。
 *
 * 架构分层：本文件是装配层（收信循环 + 路由 + 唤醒 + 工具注册 + 引导注入）；
 * 能力在 features/（trust 信任判定、thread 线程路由、mime 报文解析、
 * mailbox IMAP 连接、outbox 回信、store 状态持久化、classify 陌生来信识别）。
 *
 * @module @deepseek-ai/dsh-mail-bridge
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { classifyPrompt, interpretVerdict, isObviousSpam } from './features/classify'
import type { MailVerdict } from './features/classify'
import { InboxListener, readRecent } from './features/mailbox'
import type { ImapConfig } from './features/mailbox'
import { parseMail } from './features/mime'
import type { ParsedMail } from './features/mime'
import { sendReply } from './features/outbox'
import type { SmtpSettings } from './features/outbox'
import {
  addContact,
  clearFailure,
  emptyState,
  indexMessage,
  isProcessed,
  loadState,
  markProcessed,
  MAX_DELIVERY_ATTEMPTS,
  recordFailure,
  saveState,
  upsertThread,
} from './features/store'
import type { BridgeState } from './features/store'
import {
  createThreadTag,
  extractThreadTag,
  replySubject,
  routeMessage,
  subjectBase,
} from './features/thread'
import type { ThreadBinding, ThreadLookup } from './features/thread'
import { classifyTrust } from './features/trust'

/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
export const name = 'dsh-mail-bridge'
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** IMAP 主机。 */
  imapHost: string
  /** IMAP 端口。 */
  imapPort: number
  /** IMAP 是否使用隐式 SSL。 */
  imapSecure: boolean
  /** 收件箱目录名。 */
  inboxMailbox: string
  /** 已发送目录名（出站信任与线程末梢的回读来源）。 */
  sentMailbox: string
  /** 断线重连间隔（毫秒）。 */
  reconnectMs: number
  /** 兜底扫描间隔（毫秒）。IDLE 推送实测延迟约 40 秒且长连接会失效，
   *  周期扫描是保证「邮件一定会被处理」的安全网；设为 0 关闭。 */
  pollIntervalMs: number
  /** 单次最多处理多少封积压邮件。 */
  fetchLimit: number
  /** SMTP 主机（回信用）。 */
  smtpHost: string
  /** SMTP 端口。 */
  smtpPort: number
  /** SMTP 是否使用隐式 SSL。 */
  smtpSecure: boolean
  /** 发件邮箱账号。 */
  sender: string
  /** SMTP 授权码。 */
  authCode: string
  /** 发件人显示名。 */
  senderName: string
  /** SMTP 超时（毫秒）。 */
  smtpTimeoutMs: number
  /** 主人邮箱：指令来源与陌生来信的上报去向。 */
  owner: string
  /** 显式授权可直接触发对话的邮箱数组。 */
  allowedSenders: string[]
  /** 新建分身时挂载的 agent preset（留空则不挂载，用宿主默认模型路由）。 */
  followerPreset: string
  /** 分身专用模型 provider（留空则用宿主 agentDefaultModel 默认值）。 */
  followerProvider: string
  /** 分身专用模型 id（留空则用宿主 agentDefaultModel 默认值）。 */
  followerModel: string
  /** 新建分身的工作目录（留空用宿主进程当前目录）。 */
  followerCwd: string
  /** 是否把陌生来信摘要上报主人。 */
  reportStrangers: boolean
  /** 是否用宿主模型识别陌生来信（关闭则只做规则预筛）。 */
  classifyStrangers: boolean
  /** 状态文件路径。 */
  statePath: string
  /** 邮件分身单轮最大步数：超过即强制收尾并汇报，防止原地空转烧 token。 */
  maxStepsPerTurn: number
  /** 是否在首个 step 注入邮件桥引导。 */
  injectGuidance: boolean
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  imapHost: z.string().default('imap.qq.com'),
  imapPort: z.number().default(993),
  imapSecure: z.boolean().default(true),
  inboxMailbox: z.string().default('INBOX'),
  sentMailbox: z.string().default('Sent Messages'),
  reconnectMs: z.number().default(15000),
  pollIntervalMs: z.number().default(30000),
  fetchLimit: z.number().default(20),
  smtpHost: z.string().default('smtp.qq.com'),
  smtpPort: z.number().default(465),
  smtpSecure: z.boolean().default(true),
  sender: z.string().default(''),
  authCode: z.string().default(''),
  senderName: z.string().default('DSH 数字员工'),
  smtpTimeoutMs: z.number().default(20000),
  owner: z.string().default(''),
  allowedSenders: z.array(z.string()).default([]),
  followerPreset: z.string().default(''),
  followerProvider: z.string().default(''),
  followerModel: z.string().default(''),
  followerCwd: z.string().default(''),
  reportStrangers: z.boolean().default(true),
  classifyStrangers: z.boolean().default(true),
  statePath: z.string().default(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-mail-bridge', 'state.json')),
  maxStepsPerTurn: z.number().default(40),
  injectGuidance: z.boolean().default(true),
})

/** 本包注入消息的来源插件标签。 */
const PLUGIN_TAG = 'dsh-mail-bridge'

/** 宿主 agents 服务的最小结构（收口窄接口，便于测试）。 */
interface MailAgent {
  followup(message: UserMessage): void
  session?: { id?: string }
}

/** 宿主 agents 服务。 */
interface AgentsLike {
  get(id: string): MailAgent | undefined
  create(options: {
    sessionId: string
    meta?: Record<string, string>
    agentOptions?: Record<string, string>
    setup?(agentCtx: unknown): Promise<void>
  }): Promise<{ agent: MailAgent }>
  resume(options: {
    resumeSessionId: string
    agentOptions?: Record<string, string>
    setup?(agentCtx: unknown): Promise<void>
  }): Promise<{ agent: MailAgent }>
}

/** 宿主工作区服务（把分身挂到工作区，侧边栏才看得见）。 */
interface WorkspaceLike {
  resolveByPath(path: string): Promise<AttachableWorkspace | undefined>
  /** 工作区未注册时自动创建，保证分身一定可见（否则主人看不到任何对话）。 */
  create(path: string, title?: string): Promise<AttachableWorkspace>
}

/** 可挂载会话的工作区。 */
interface AttachableWorkspace {
  attachSession(sessionId: string): Promise<void>
}

/** 宿主 agentPresets 服务。 */
interface PresetsLike {
  resolve(id: string): Promise<unknown>
  mount(agentCtx: unknown, id: string): Promise<unknown>
}

/** 运行日志（写到宿主 stdout，便于事后追溯路由判定）。 */
function log(message: string): void {
  console.error(`[dsh-mail-bridge] ${message}`)
}

/** 当前时间戳（ISO）。 */
function now(): string {
  return new Date().toISOString()
}

/** 宿主默认模型服务：为新建/续接的分身提供 provider/model。 */
interface DefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: unknown }
}

/**
 * 解析新建/续接分身要用的模型路由。
 *
 * 为什么不能读 `ctx.agent`：Cordis 禁止访问未在 `inject` 里声明的属性，直接读会抛
 * `cannot get property "agent" without inject`——而且收信回调属于后台上下文，
 * 本就没有「调用方 agent」。正确来源是宿主的 agentDefaultModel 服务；
 * 用 ctx.get 惰性读取（取不到就返回空，交由宿主自身默认处理）。
 */
function resolveAgentOptions(ctx: Context, config: Config): Record<string, string> {
  // 部署显式钉住的路由优先：数字员工不该因为有人在 UI 上改了全局默认模型就整体瘫痪
  if (config.followerProvider.length > 0 && config.followerModel.length > 0) {
    return { provider: config.followerProvider, model: config.followerModel }
  }
  const service = ctx.get('agentDefaultModel') as DefaultModelLike | undefined
  if (service === undefined) return {}
  try {
    const selected = service.currentSelection()
    const out: Record<string, string> = { provider: selected.provider, model: selected.model }
    if (selected.reasoningEffort !== undefined) {
      out.reasoningEffort = ReasoningEffortId(String(selected.reasoningEffort))
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 第一封指令的作业准则：**两阶段工作制**。
 *
 * 为什么必须这样（用户明确要求）：数字员工不许「蒙头干活」。收到指令先给方案、
 * 等主人批准，才允许动真实代码/环境——否则主人无从监督，出事也无法追责。
 * 「必须汇报」同样是硬要求：无论成功、失败还是卡住，结束前都要回信，
 * 否则主人只会看到「发了邮件没任何反应」。
 */
const PLAN_RULES = [
  '处置要求（两阶段工作制，必须严格遵守）：',
  '1. 本轮**只做只读调研**：可以读代码、查团队记忆与知识库、查看运行状态；',
  '   **绝对不要**修改文件、执行写操作、部署、或对外发送邮件。',
  '2. 基于调研给出**执行方案**：打算做什么、改哪些文件、有什么风险与影响范围。',
  '3. 用 mail_reply 把方案回信给主人，并明确请主人确认。',
  '4. 发完这封回信就**立即结束本轮，不要开始执行**。',
  '5. 主人回复确认后你会再次被唤醒，那时才真正动手。',
  '6. 无论本轮成功、失败还是卡住，**结束前必须用 mail_reply 汇报**；卡住也要说清卡在哪。',
].join('\n')

/**
 * 后续轮次的作业准则：主人已看过方案，按批准结果决定执行或再请示。
 * 同样要求「必须汇报」——这是主人掌握进展的唯一渠道。
 */
const EXECUTE_RULES = [
  '处置要求：',
  '1. 这是主人对方案的回应：主人批准 → 开始执行；要求修改 → 调整方案后再用 mail_reply 请示，不要擅自执行。',
  '2. 执行前先复述你要做什么，避免误解。',
  '3. 如果发现自己在原地打转（同类操作反复无效），立即停止并汇报卡点，不要硬撑。',
  '4. 无论成功、失败还是卡住，**结束前必须用 mail_reply 汇报结果**：做了什么、结果如何、有无遗留。',
].join('\n')

/** 组装喂给分身的邮件正文提示词。 */
function mailPrompt(mail: ParsedMail, tag: string, role: string): string {
  const lines = [
    `【邮件任务｜${role}】你收到了来自 ${mail.fromAddress} 的邮件，它属于你的专属邮件对话线程 [#${tag}]。`,
    '',
    `发件人：${mail.fromName.length > 0 ? `${mail.fromName} <${mail.fromAddress}>` : mail.fromAddress}`,
    `主题：${mail.subject}`,
    ...(mail.date !== undefined ? [`时间：${mail.date}`] : []),
    ...(mail.attachments.length > 0
      ? [`附件：${mail.attachments.map(a => `${a.filename}（${Math.round(a.size / 1024)} KB）`).join('、')}`]
      : []),
    '',
    '正文：',
    mail.text.length > 0 ? mail.text.slice(0, 20000) : '（无正文）',
    '',
    '---',
    role === '主人新指令' || role === 'established 对端新话题'
      ? PLAN_RULES
      : EXECUTE_RULES,
  ]
  return lines.join('\n')
}

/** 工具返回值契约：必须可无损 JSON 化（宿主对工具返回值有此硬要求）。 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** 工具返回值对象。 */
type JsonObject = { [key: string]: JsonValue }

/** 桥接运行时：收信循环、路由、唤醒、回信。 */
interface BridgeRuntime {
  start(): void
  stop(): Promise<void>
  status(): JsonObject
  threads(): JsonObject
  /** 该会话是否为邮件桥创建的分身（用于施加步数护栏）。 */
  isFollower(sessionId: string): boolean
  reply(sessionId: string, body: string, attachments: readonly string[]): Promise<JsonObject>
}

/**
 * 创建桥接运行时。
 * @param ctx - 宿主上下文（提供 agents/agentPresets/llm）。
 * @param config - 插件配置。
 */
function createRuntime(ctx: Context, config: Config): BridgeRuntime {
  const agents = ctx.get('agents') as AgentsLike | undefined
  const presets = ctx.get('agentPresets') as PresetsLike | undefined
  const llm = ctx.get('llm') as LlmRuntime | undefined
  const workspaces = ctx.get('workspaceRegistry') as WorkspaceLike | undefined

  const imap: ImapConfig = {
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    user: config.sender,
    pass: config.authCode,
    inboxMailbox: config.inboxMailbox,
    sentMailbox: config.sentMailbox,
    reconnectMs: config.reconnectMs,
  }
  const smtp: SmtpSettings = {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    user: config.sender,
    pass: config.authCode,
    fromName: config.senderName,
    timeoutMs: config.smtpTimeoutMs,
  }

  let state: BridgeState = loadState(config.statePath)
  let processing = false
  let rescan = false
  let stopped = false
  let pollTimer: ReturnType<typeof setInterval> | undefined

  const listener = new InboxListener(imap, {
    onNewMail: () => { void runInbox() },
    onStatus: message => log(message),
    onError: error => log(`IMAP 错误：${error.message}`),
  })

  /** 线程索引：把持久化状态暴露给纯计算的路由砖块。 */
  const lookup: ThreadLookup = {
    hasTag: tag => state.threads[tag] !== undefined,
    tagForMessageId: messageId => state.messageIndex[messageId],
  }

  /** 持久化当前状态。 */
  function persist(): void {
    try {
      saveState(config.statePath, state)
    } catch (error) {
      log(`状态写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 回读「已发送」，同时完成两件事：
   *   1. 出站建立信任——我们主动发过邮件的对端获得回复触发资格；
   *   2. 同步线程末梢——QQ 会重写 Message-ID（实测），
   *      只有回读才能知道发出的那封真实的 Message-ID，用户点「回复」时才接得上。
   */
  async function syncOutbound(): Promise<void> {
    let messages
    try {
      messages = await readRecent(imap, config.sentMailbox, 30, state.sentLastUid)
    } catch (error) {
      log(`回读已发送失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let changed = false
    for (const raw of messages) {
      if (raw.uid <= state.sentLastUid) continue
      const mail = await parseMail(raw.uid, raw.source)
      for (const address of mail.to) {
        if (!state.contacts.includes(address)) {
          addContact(state, address)
          changed = true
        }
      }
      const tag = extractThreadTag(mail.subject)
      if (tag !== undefined) {
        indexMessage(state, mail.messageId, tag)
        const binding = state.threads[tag]
        if (binding !== undefined) {
          binding.references = [...new Set([...binding.references, mail.messageId])]
          binding.lastMessageId = mail.messageId
          binding.updatedAt = now()
          upsertThread(state, binding)
        }
        changed = true
      }
      state.sentLastUid = raw.uid
      changed = true
    }
    if (changed) persist()
  }

  /** 用宿主模型识别陌生来信；无模型能力时返回 unknown（由规则结果决定）。 */
  async function classify(mail: ParsedMail): Promise<MailVerdict> {
    if (!config.classifyStrangers || llm === undefined) return 'unknown'
    try {
      const providers = llm.listProviders()
      const providerId = providers[0]?.id
      if (providerId === undefined) return 'unknown'
      const models = await llm.listModels(providerId)
      const modelId = models[0]?.id
      if (modelId === undefined) return 'unknown'
      const prepared = await llm.prepareCall({ provider: providerId, model: modelId })
      const request = {
        provider: providerId,
        model: prepared.config.model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: classifyPrompt(mail) }],
          source: { kind: 'plugin' as const, plugin: PLUGIN_TAG, form: 'instructions' as const },
        })],
      }
      let answer = ''
      for await (const chunk of prepared.stream(request)) {
        if (chunk.type === 'text-delta') answer += chunk.text
      }
      return interpretVerdict(answer)
    } catch (error) {
      log(`陌生来信识别失败，按未识别处理：${error instanceof Error ? error.message : String(error)}`)
      return 'unknown'
    }
  }

  /** 唤醒一个已存在的分身：活会话直接 followup，否则 resume 续接同一对话。 */
  async function wake(sessionId: string, prompt: string): Promise<boolean> {
    if (agents === undefined) return false
    const message = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: PLUGIN_TAG, form: 'instructions' },
    })
    const live = agents.get(sessionId)
    if (live !== undefined) {
      live.followup(message)
      return true
    }
    // 会话已不在内存（宿主重启等）：续接持久化会话，天然避开「id 已存在」崩溃
    try {
      const resumed = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: resolveAgentOptions(ctx, config),
        ...(config.followerPreset.length > 0
          ? { setup: async (agentCtx: unknown) => { await presets?.mount(agentCtx, config.followerPreset) } }
          : {}),
      })
      resumed.agent.followup(message)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`续接会话失败（session=${sessionId}）：${detail}`)
      throw new Error(`续接会话失败：${detail}`)
    }
  }

  /** 新建一个分身会话并绑定线程（主人新指令 / 信任对端的新话题）。 */
  async function createFollower(mail: ParsedMail, role: string): Promise<void> {
    if (agents === undefined) {
      log('agents 服务不可用，无法新建分身')
      return
    }
    const tag = createThreadTag()
    const sessionId = `mail-${randomUUID()}`
    const binding: ThreadBinding = {
      tag,
      sessionId,
      peer: mail.fromAddress,
      subjectBase: subjectBase(mail.subject),
      lastMessageId: mail.messageId,
      references: [...new Set([...mail.references, mail.messageId])],
      createdAt: now(),
      updatedAt: now(),
    }
    // 注意顺序：**先建分身、建成功后才落线程绑定**。
    // 反过来的话，创建失败时会在状态里留下指向不存在会话的孤儿线程，
    // 而重试机制会让孤儿越积越多（实测踩过）。
    const agentOptions = resolveAgentOptions(ctx, config)
    const cwd = config.followerCwd.length > 0 ? config.followerCwd : process.cwd()
    const meta: Record<string, string> = { cwd, mailThreadTag: tag, mailPeer: mail.fromAddress }
    try {
      if (config.followerPreset.length > 0) {
        if (presets === undefined) throw new Error('agentPresets 服务不可用')
        await presets.resolve(config.followerPreset)
        meta.agentPreset = config.followerPreset
      }
      const handle = await agents.create({
        sessionId,
        meta,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        ...(config.followerPreset.length > 0
          ? { setup: async (agentCtx: unknown) => { await presets?.mount(agentCtx, config.followerPreset) } }
          : {}),
      })
      upsertThread(state, binding)
      indexMessage(state, mail.messageId, tag)
      persist()
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: mailPrompt(mail, tag, role) }],
        source: { kind: 'plugin', plugin: PLUGIN_TAG, form: 'instructions' },
      }))
      // 挂到工作区，否则分身虽然建好了，却在侧边栏里完全看不见——
      // 用户会以为「发邮件没任何反应」，而实际分身正在后台干活（实测踩过）。
      // 注意：找不到工作区时**必须自动创建**而不是静默跳过；上一版就是因为
      // followerCwd 不在已注册工作区列表里而静默跳过，分身全部成了孤儿会话。
      if (workspaces === undefined) {
        log('workspaceRegistry 服务不可用：分身不会出现在侧边栏')
      } else {
        try {
          const workspace = await ensureFollowerWorkspace()
          if (workspace === undefined) throw new Error('无法解析或创建邮件分身工作区')
          await workspace.attachSession(sessionId)
          log(`分身已挂到工作区「${followerWorkspacePath()}」`)
        } catch (error) {
          log(`分身归属工作区失败（不阻断本次处理）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      log(`已新建分身 session=${sessionId} 绑定线程 [#${tag}] 对端 ${mail.fromAddress}`)
    } catch (error) {
      // 抛出而不是吞掉：交给收信循环按 MAX_DELIVERY_ATTEMPTS 重试，
      // 否则一次瞬时失败就会把这封信永久丢掉。
      const detail = error instanceof Error ? error.message : String(error)
      log(`新建分身失败（session=${sessionId}）：${detail}`)
      throw new Error(`新建分身失败：${detail}`)
    }
  }

  /** 把陌生来信摘要上报主人，由主人决定是否指派。 */
  async function reportToOwner(mail: ParsedMail, reason: string): Promise<void> {
    if (config.owner.length === 0) {
      log(`陌生来信但未配置主人邮箱，无法上报：${mail.fromAddress}`)
      return
    }
    const body = [
      `有一封陌生来信需要你决定如何处理（${reason}）。`,
      '',
      `发件人：${mail.fromName.length > 0 ? `${mail.fromName} <${mail.fromAddress}>` : mail.fromAddress}`,
      `主题：${mail.subject}`,
      ...(mail.date !== undefined ? [`时间：${mail.date}`] : []),
      '',
      '正文：',
      mail.text.slice(0, 4000),
      '',
      '---',
      '如果你要让它变成一个任务，直接**回复这封邮件**并说明要做什么，我会新建一个分身去办。',
    ].join('\n')
    const outcome = await sendReply(smtp, {
      to: [config.owner],
      subject: `[邮件桥] 陌生来信：${mail.subject.length > 0 ? mail.subject : '(无主题)'}`,
      text: body,
      references: [],
    })
    log(outcome.ok
      ? `已上报主人陌生来信：${mail.fromAddress}`
      : `上报主人失败：${outcome.error}`)
  }

  /** 处理一封陌生来信：先规则预筛，再交模型识别，最后决定上报或忽略。 */
  async function handleStranger(mail: ParsedMail): Promise<void> {
    if (isObviousSpam(mail)) {
      log(`忽略疑似广告：${mail.fromAddress} / ${mail.subject}`)
      return
    }
    const verdict = await classify(mail)
    if (verdict === 'spam') {
      log(`模型判定为广告，忽略：${mail.fromAddress} / ${mail.subject}`)
      return
    }
    if (!config.reportStrangers) {
      log(`陌生来信（未开启上报）：${mail.fromAddress} / ${mail.subject}`)
      return
    }
    await reportToOwner(mail, verdict === 'meaningful' ? '模型判定为需要处理' : '无法自动判定')
  }

  /** 处理单封来信：解析 → 信任判定 → 路由 → 执行。 */
  async function handleMessage(uid: number, source: Buffer): Promise<void> {
    const mail = await parseMail(uid, source)
    if (mail.fromAddress.length === 0) {
      log(`UID ${uid} 无法解析发件人，跳过`)
      return
    }
    // 自动回复不再触发新动作：否则「分身回信 → 落回自己邮箱 → 再唤醒分身 → 再回信」
    // 会形成无限自回环（实测把回信地址设为自身时必然发生）。
    if (mail.autoSubmitted) {
      log(`UID ${uid} 是自动回复（RFC 3834 Auto-Submitted），忽略以避免环路`)
      return
    }
    const trust = classifyTrust(mail.fromAddress, {
      owner: config.owner,
      allowedSenders: config.allowedSenders,
    }, new Set(state.contacts))
    const decision = routeMessage({
      from: mail.fromAddress,
      subject: mail.subject,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
    }, trust, lookup)
    log(`来信 UID ${uid} 来自 ${mail.fromAddress}（信任=${trust}）→ ${decision.kind}：${decision.reason}`)

    if (decision.kind === 'thread' && decision.tag !== undefined) {
      const binding = state.threads[decision.tag]
      if (binding === undefined) return
      // 对端来信成为新的线程末梢，我们的下一次回信要挂在它下面
      binding.references = [...new Set([...binding.references, mail.messageId])]
      binding.lastMessageId = mail.messageId
      binding.updatedAt = now()
      upsertThread(state, binding)
      persist()
      const role = trust === 'owner' ? '主人指令' : '对端回复'
      const ok = await wake(binding.sessionId, mailPrompt(mail, decision.tag, role))
      if (!ok) log(`唤醒会话失败，邮件已记录但未处理（session=${binding.sessionId}）`)
      return
    }

    if (decision.kind === 'owner-new') {
      await createFollower(mail, '主人新指令')
      return
    }
    if (decision.kind === 'trusted-new') {
      await createFollower(mail, `${trust} 对端新话题`)
      return
    }
    await handleStranger(mail)
  }

  /**
   * 收信主循环：按 UID 水位增量拉取并逐封处理。
   * 串行化——同一时刻只跑一轮，期间到达的推送只置重扫标记，避免并发写状态。
   */
  async function runInbox(): Promise<void> {
    if (stopped) return
    if (processing) { rescan = true; return }
    processing = true
    try {
      do {
        rescan = false
        // 首次启动（水位为 0）：先把水位对齐到当前最大 UID。
        // 不这么做的话，有界区间会固定落在不存在的 UID 段上，新邮件永久漏收。
        if (state.lastUid === 0) {
          try {
            const baseline = await listener.currentMaxUid()
            state.lastUid = baseline
            persist()
            log(`首次启动：收件箱水位基线对齐到 UID ${baseline}（不重放历史邮件）`)
          } catch (error) {
            // 连接尚未就绪：本轮跳过，交给下一轮（周期扫描）重试，不会永久卡死
            log(`水位基线对齐失败，稍后重试：${error instanceof Error ? error.message : String(error)}`)
            return
          }
        }
        let batch
        try {
          batch = await listener.fetchSince(state.lastUid, config.fetchLimit)
        } catch (error) {
          log(`拉取邮件失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        for (const raw of batch) {
          if (isProcessed(state, raw.uid)) continue
          try {
            await handleMessage(raw.uid, raw.source)
            clearFailure(state, raw.uid)
            markProcessed(state, raw.uid)
          } catch (error) {
            // 失败不立即丢弃：先重试，避免瞬时故障（服务未就绪/网络抖动）丢信
            const attempts = recordFailure(state, raw.uid)
            const detail = error instanceof Error ? error.message : String(error)
            if (attempts >= MAX_DELIVERY_ATTEMPTS) {
              log(`处理 UID ${raw.uid} 连续失败 ${attempts} 次，放弃并推进水位（避免阻塞收信）：${detail}`)
              markProcessed(state, raw.uid)
            } else {
              log(`处理 UID ${raw.uid} 失败（第 ${attempts}/${MAX_DELIVERY_ATTEMPTS} 次，下轮重试）：${detail}`)
            }
          }
          persist()
        }
      } while (rescan && !stopped)
    } finally {
      processing = false
    }
  }

  /** 分身统一挂载的工作区目录。 */
  function followerWorkspacePath(): string {
    return config.followerCwd.length > 0 ? config.followerCwd : process.cwd()
  }

  /**
   * 确保「邮件分身」工作区存在并返回它。
   * 找不到就创建而不是静默跳过——上一版就是因此让所有分身成了侧边栏里看不见的孤儿。
   */
  async function ensureFollowerWorkspace(): Promise<AttachableWorkspace | undefined> {
    if (workspaces === undefined) return undefined
    const path = followerWorkspacePath()
    return await workspaces.resolveByPath(path) ?? await workspaces.create(path, '邮件分身')
  }

  /**
   * 启动时把历史分身补齐挂载。
   * 为什么需要：修复挂载逻辑之前创建的分身都没进工作区，主人的对话记录等于丢了；
   * 启动时补一次，让过去的往来也能在侧边栏回看。
   */
  async function attachKnownFollowers(): Promise<void> {
    const sessions = Object.values(state.threads).map(binding => binding.sessionId)
    if (sessions.length === 0) return
    try {
      const workspace = await ensureFollowerWorkspace()
      if (workspace === undefined) return
      let attached = 0
      for (const sessionId of sessions) {
        try {
          await workspace.attachSession(sessionId)
          attached++
        } catch {
          // 会话可能已被清理，跳过即可，不影响其他分身
        }
      }
      log(`历史分身挂载补齐：${attached}/${sessions.length} 个已进入工作区「${followerWorkspacePath()}」`)
    } catch (error) {
      log(`历史分身挂载补齐失败（不阻断收信）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 找出某个会话当前绑定的线程（一个会话同时只维护一条线程）。 */
  function threadOfSession(sessionId: string): ThreadBinding | undefined {
    for (const binding of Object.values(state.threads)) {
      if (binding.sessionId === sessionId) return binding
    }
    return undefined
  }

  return {
    start(): void {
      if (config.sender.length === 0 || config.authCode.length === 0) {
        log('未配置 sender/authCode，邮件桥不启动（仅注册工具）')
        return
      }
      listener.start()
      // 兜底周期扫描：IDLE 推送实测延迟约 40 秒，且长连接可能静默失效，
      // 只靠推送会漏信；周期扫描保证「邮件最终一定会被处理」。
      if (config.pollIntervalMs > 0) {
        pollTimer = setInterval(() => { void runInbox() }, config.pollIntervalMs)
      }
      // 启动补课：先同步出站信任与线程末梢，再补拉离线期间的来信
      void (async () => {
        await syncOutbound()
        await attachKnownFollowers()
        await runInbox()
      })()
    },

    async stop(): Promise<void> {
      stopped = true
      if (pollTimer !== undefined) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
      await listener.stop()
    },

    status(): JsonObject {
      return {
        connected: listener.isConnected(),
        inboxMailbox: config.inboxMailbox,
        sentMailbox: config.sentMailbox,
        inboxWatermark: state.lastUid,
        sentWatermark: state.sentLastUid,
        knownThreads: Object.keys(state.threads).length,
        establishedContacts: state.contacts.length,
        owner: config.owner,
        allowedSenders: [...config.allowedSenders],
      }
    },

    isFollower(sessionId: string): boolean {
      return Object.values(state.threads).some(binding => binding.sessionId === sessionId)
    },

    threads(): JsonObject {
      const out: JsonObject = {}
      for (const [tag, binding] of Object.entries(state.threads)) {
        out[tag] = {
          sessionId: binding.sessionId,
          peer: binding.peer,
          subject: binding.subjectBase,
          lastMessageId: binding.lastMessageId,
          updatedAt: binding.updatedAt,
        }
      }
      return out
    },

    /**
     * 以「回复」方式回信：自动挂上线程头与主题标签，并回读已发送取回真实 Message-ID。
     * 这是线程镜像的核心——所有回信都走这里，绝不用 email_send 另起新邮件。
     */
    async reply(sessionId: string, body: string, attachments: readonly string[]): Promise<JsonObject> {
      const binding = threadOfSession(sessionId)
      if (binding === undefined) {
        return {
          ok: false,
          error: '当前会话尚未绑定邮件线程：只有由收信唤醒或新建的分身才能回信',
          hint: '若是主人希望主动联系某人，请改用 email_send 发出第一封邮件',
        }
      }
      const text = body.trim()
      if (text.length === 0) return { ok: false, error: '回信正文不能为空' }

      const outcome = await sendReply(smtp, {
        to: [binding.peer],
        subject: replySubject(binding.subjectBase, binding.tag),
        text,
        inReplyTo: binding.lastMessageId,
        references: binding.references,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      if (!outcome.ok) {
        return {
          ok: false,
          error: outcome.error,
          ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
        }
      }
      // QQ 会重写 Message-ID，必须回读「已发送」才知道真实 ID，作为下一封的线程末梢
      await syncOutbound()
      const updated = state.threads[binding.tag]
      return {
        ok: true,
        threadTag: binding.tag,
        to: [binding.peer],
        subject: replySubject(binding.subjectBase, binding.tag),
        newMessageId: updated?.lastMessageId ?? outcome.messageId,
        response: outcome.response,
      }
    },
  }
}

/**
 * 步数护栏提示词：邮件分身单轮步数逼近上限时注入，强制其收尾汇报。
 * 实测教训：一个分身曾连续调用 120 次工具（其中 110 次在跟终端输出较劲）
 * 却不回信，主人完全不知道进展——所以「原地打转」必须被主动打断。
 */
function stepLimitNotice(step: number, limit: number): string {
  return [
    `【强制收尾】本会话单轮步数已达 ${step}（上限 ${limit}）。`,
    '请立即停止新的探索与尝试，现在就：',
    '1. 用 mail_reply 汇报当前进展：已经完成了什么、卡在哪里、下一步计划是什么；',
    '2. 然后结束本轮。',
    '不要继续调试或重试，主人在等你的汇报。',
  ].join('\n')
}

/** 折叠进首个 agent step 的邮件桥引导。 */
function buildGuidance(): string {
  return [
    '【邮件桥】本会话可能绑定了邮件对话线程（dsh-mail-bridge）：',
    '- mail_reply(body, attachments?)：**以回复方式**回信，自动接在同一邮件线程（同一主题 + 线程头 + [#会话标签]），对方点回复就能回到你这个分身。',
    '- mail_threads()：查看当前所有邮件线程与 DSH 会话的绑定关系。',
    '- mail_status()：查看收信连接与增量水位状态。',
    '回信一律用 mail_reply；只有需要主动联系一个还没有邮件线程的新对象时才用 email_send。',
  ].join('\n')
}

/**
 * 已注入过引导的会话（进程内记忆）。
 * 为什么不用扫描会话表面判断：本 harness 版本的 Session 未公开历史事件访问器，
 * 而进程内记忆已足够——宿主重启后重新注入一次引导是无害的。
 */
const guidedAgents = new WeakSet<Agent>()

/** 把工具返回值以美化 JSON 文本呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 工具调用展示卡片。 */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/** 从工具参数中取字符串。 */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 从工具参数中取字符串数组。 */
function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : []
}

/**
 * 注册邮件桥插件：收信循环 + 三个工具 + 引导注入。
 * @param ctx - Cordis 注册上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  let runtimeHolder: BridgeRuntime | undefined

  // 1) 工具注册（不依赖 agents 服务，先注册好，收信链路随后就绪）
  const tools = {
    reply: defineTool({
      name: 'mail_reply',
      description: '以「回复」方式回信给本会话所属邮件线程的对端（自动保持同一邮件线程）。由邮件唤醒或新建的分身才可用。',
      parameters: {
        body: { type: 'string', description: '回信正文（纯文本）', required: true },
        attachments: { type: 'array', items: { type: 'string' }, description: '附件本地绝对路径列表（可选）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args, exec) => {
        const runtime = runtimeHolder
        if (runtime === undefined) return { ok: false, error: '邮件桥尚未就绪（等待 agents 服务）' }
        const sessionId = exec.agent?.session?.id
        if (sessionId === undefined) return { ok: false, error: '无法确定当前会话，不能在无会话上下文中回信' }
        return runtime.reply(sessionId, readOptionalString(args.body) ?? '', readStringArray(args.attachments))
      },
      presentCall: args => presentCall('Reply by email', args),
    }),
    threads: defineTool({
      name: 'mail_threads',
      description: '查看当前所有邮件线程与 DSH 会话的绑定关系（线程标签、对端地址、主题、线程末梢）。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async () => runtimeHolder?.threads() ?? { error: '邮件桥尚未就绪' },
      presentCall: args => presentCall('List mail threads', args),
    }),
    status: defineTool({
      name: 'mail_status',
      description: '查看邮件桥运行状态：IMAP 连接、收件箱/已发送水位、已知线程数、出站信任联系人数。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async () => runtimeHolder?.status() ?? { error: '邮件桥尚未就绪' },
      presentCall: args => presentCall('Mail bridge status', args),
    }),
  }
  for (const tool of Object.values(tools)) ctx.tools.register(tool)

  // 2) 收信循环：等 agents/agentPresets 就绪后启动，并注册可逆的生命周期副作用
  ctx.inject(['agents'], (nativeCtx) => {
    const runtime = createRuntime(nativeCtx, config)
    runtimeHolder = runtime
    nativeCtx.effect(() => {
      runtime.start()
      log('邮件桥已启动：IMAP 监听 + 邮件→会话路由')
      return async () => { await runtime.stop() }
    })
  })

  // 3) 引导注入：仅当开启且尚未注入时，向会话表面追加一条插件来源说明。
  if (config.injectGuidance) {
    ctx.on('agent/pre-step', async (
      { agent, messages, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (guidedAgents.has(agent)) return decision
      signal.throwIfAborted()
      guidedAgents.add(agent)
      const guidance = createUserMessage({
        content: [{ type: 'text', text: buildGuidance() }],
        source: { kind: 'plugin', plugin: PLUGIN_TAG, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }

  // 4) 步数护栏：邮件分身单轮步数达到上限后，每 10 步注入一次强制收尾指令。
  //    为什么必须由插件强制：提示词管不住长时间空转，只有运行时打断才可靠。
  ctx.on('agent/pre-step', async (
    { agent, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const runtime = runtimeHolder
    if (runtime === undefined) return decision
    const limit = config.maxStepsPerTurn
    if (limit <= 0 || step < limit || (step - limit) % 10 !== 0) return decision
    if (!runtime.isFollower(agent.session.id)) return decision
    signal.throwIfAborted()
    const notice = createUserMessage({
      content: [{ type: 'text', text: stepLimitNotice(step, limit) }],
      source: { kind: 'plugin', plugin: PLUGIN_TAG, form: 'instructions' },
    })
    return { kind: 'enter', messages: [...decision.messages, notice] }
  })
}

export { emptyState }

/**
 * 状态存储砖块：把「邮件线程 ↔ 会话」的绑定、出站信任联系人、已处理 UID
 * 落到磁盘，保证宿主重启后线程不断、邮件不重复处理。
 *
 * 为什么必须持久化：Message-ID 由 QQ 重写（实测），线程末梢只能靠我们自己记；
 * 一旦丢失，用户点「回复」就再也找不到对应分身。
 *
 * 纯状态变换（upsert/index/contact/markProcessed）与文件 IO 分离：
 * 前者是纯函数可单测，后者集中在本文件末尾。
 *
 * @module @deepseek-ai/dsh-mail-bridge/features/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ThreadBinding } from './thread'

/** 已处理 UID 的记忆上限：防止状态文件无限增长。 */
export const PROCESSED_UID_LIMIT = 500

/** 桥接状态（持久化单元）。 */
export interface BridgeState {
  /** 结构版本，便于将来迁移。 */
  version: 1
  /** 会话标签 → 线程绑定。 */
  threads: Record<string, ThreadBinding>
  /** Message-ID → 会话标签（线程头兜底路由的索引）。 */
  messageIndex: Record<string, string>
  /** 出站建立信任的联系人（小写地址）。 */
  contacts: string[]
  /** 已处理过的最大 UID（增量拉取水位）。 */
  lastUid: number
  /** 最近处理过的 UID（去重，防 IMAP 重复推送）。 */
  processedUids: number[]
  /** UID → 连续失败次数：失败不立即丢弃，重试若干次后才放弃。 */
  failedAttempts: Record<string, number>
  /** 已回读到的「已发送」最大 UID（出站信任与线程末梢的同步水位）。 */
  sentLastUid: number
}

/** 空状态。 */
export function emptyState(): BridgeState {
  return { version: 1, threads: {}, messageIndex: {}, contacts: [], lastUid: 0, processedUids: [], failedAttempts: {}, sentLastUid: 0 }
}

/** 写入或更新一条线程绑定。 */
export function upsertThread(state: BridgeState, binding: ThreadBinding): void {
  state.threads[binding.tag] = binding
  if (binding.lastMessageId.length > 0) state.messageIndex[binding.lastMessageId] = binding.tag
}

/**
 * 记录某个 Message-ID 属于哪个会话标签（线程头兜底路由的索引来源）。
 * 为什么单独记：我们发出的邮件被 QQ 重写 Message-ID 后，只有回读已发送
 * 才能知道真实 ID；把它索引起来，用户点「回复」带来的 In-Reply-To 才能命中。
 */
export function indexMessage(state: BridgeState, messageId: string, tag: string): void {
  if (messageId.length === 0) return
  state.messageIndex[messageId] = tag
}

/** 登记一个出站联系人（我们主动发过邮件的对端 → 获得回复触发资格）。 */
export function addContact(state: BridgeState, address: string): void {
  const normalized = address.trim().toLowerCase()
  if (normalized.length === 0) return
  if (!state.contacts.includes(normalized)) state.contacts.push(normalized)
}

/** 标记 UID 已处理（幂等）。 */
export function markProcessed(state: BridgeState, uid: number): void {
  if (uid > state.lastUid) state.lastUid = uid
  if (state.processedUids.includes(uid)) return
  state.processedUids.push(uid)
  if (state.processedUids.length > PROCESSED_UID_LIMIT) {
    state.processedUids = state.processedUids.slice(-PROCESSED_UID_LIMIT)
  }
}

/** 单封邮件的最大投递尝试次数：超过即放弃并推进水位，避免坏邮件永久阻塞收信。 */
export const MAX_DELIVERY_ATTEMPTS = 3

/**
 * 记一次处理失败并返回累计次数。
 * 为什么需要重试：瞬时故障（服务未就绪、网络抖动）不该把邮件直接丢掉——
 * 但也不能无限重试，否则一封毒邮件会永久卡住整个收信循环。
 */
export function recordFailure(state: BridgeState, uid: number): number {
  const key = String(uid)
  const attempts = (state.failedAttempts[key] ?? 0) + 1
  state.failedAttempts[key] = attempts
  return attempts
}

/** 处理成功后清除失败记录。 */
export function clearFailure(state: BridgeState, uid: number): void {
  delete state.failedAttempts[String(uid)]
}

/** 该 UID 是否已处理过（IMAP 重连后可能重复推送）。 */
export function isProcessed(state: BridgeState, uid: number): boolean {
  return state.processedUids.includes(uid)
}

/** 从磁盘读取状态；文件缺失或损坏时返回空状态（不阻断启动）。 */
export function loadState(path: string): BridgeState {
  if (!existsSync(path)) return emptyState()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeState>
    return {
      version: 1,
      threads: raw.threads ?? {},
      messageIndex: raw.messageIndex ?? {},
      contacts: raw.contacts ?? [],
      lastUid: typeof raw.lastUid === 'number' ? raw.lastUid : 0,
      processedUids: raw.processedUids ?? [],
      failedAttempts: raw.failedAttempts ?? {},
      sentLastUid: typeof raw.sentLastUid === 'number' ? raw.sentLastUid : 0,
    }
  } catch {
    return emptyState()
  }
}

/** 原子写回状态：先写临时文件再 rename，避免进程中断留下半截 JSON。 */
export function saveState(path: string, state: BridgeState): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
  renameSync(temporary, path)
}

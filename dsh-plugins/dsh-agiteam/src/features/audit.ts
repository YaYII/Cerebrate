/**
 * 审计日志 —— 追加式 JSONL + sha256 链式指纹。
 *
 * 为什么独立成砖块：审计是纯数据能力（追加/哈希/校验），无 agent/业务依赖。
 *
 * 防篡改设计：
 *  1. 追加式：只允许 append，不允许改写历史（业务层保证只追加）；
 *  2. 链式哈希：每条目的 hash = sha256(seq|time|action|role|detail|fingerprint|prevHash)，
 *     下一条目记录 prevHash —— 任何一条被篡改，其后所有 hash 校验失败；
 *  3. 指纹：关键动作携带数据指纹（如产物 sha256），校验数据未被替换。
 *
 * 审计日志落盘：<项目>/.teamdev/<projectId>/audit.jsonl（每行一条 JSON）。
 */

import { createHash } from 'node:crypto'
import type { AuditEntry } from './model'

/** 计算 sha256 十六进制摘要。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 计算一条审计条目的哈希（不含 hash 字段本身）。 */
export function entryHash(entry: Omit<AuditEntry, 'hash'>): string {
  const material = [
    entry.seq,
    entry.time,
    entry.action,
    entry.role,
    entry.projectId,
    entry.stage,
    entry.detail,
    entry.fingerprint ?? '',
    entry.prevHash,
  ].join('|')
  return sha256Hex(material)
}

/** 构造一条审计条目（自动计算 hash）。 */
export function makeAuditEntry(
  seq: number,
  input: Omit<AuditEntry, 'seq' | 'prevHash' | 'hash'>,
  prevHash: string,
): AuditEntry {
  const base = { ...input, seq, prevHash }
  return { ...base, hash: entryHash(base) }
}

/** 校验一条审计条目的哈希是否匹配（未篡改）。 */
export function verifyEntryHash(entry: AuditEntry): boolean {
  return entry.hash === entryHash(entry)
}

/** 校验整条审计链（每条 hash 自洽 + prevHash 连续）。返回首个断裂位置（-1=完整）。 */
export function verifyAuditChain(entries: AuditEntry[]): number {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (!verifyEntryHash(entry)) return i
    if (i > 0 && entry.prevHash !== entries[i - 1]!.hash) return i
  }
  return -1
}

/** 把审计条目序列化为 JSONL 行。 */
export function entryToLine(entry: AuditEntry): string {
  return JSON.stringify(entry)
}

/** 从 JSONL 行解析审计条目（坏行返回 undefined）。 */
export function lineToEntry(line: string): AuditEntry | undefined {
  try {
    return JSON.parse(line) as AuditEntry
  } catch {
    return undefined
  }
}

/** 解析审计日志全文（跳过坏行）。 */
export function parseAuditLog(text: string): AuditEntry[] {
  return text.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => lineToEntry(line))
    .filter((e): e is AuditEntry => e !== undefined)
}

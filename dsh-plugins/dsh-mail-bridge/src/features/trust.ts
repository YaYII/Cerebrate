/**
 * 信任判定砖块：决定一封来信「有没有资格驱动机器」。
 *
 * 业务规则（用户明确要求）：不设传统白名单。信任来自三条来源——
 *   1. 主人邮箱：最高权限，来信即指令；
 *   2. 显式授权数组：配置里列出的地址；
 *   3. **出站建立信任**：我们主动给谁发过邮件，谁就有资格回复并触发。
 * 其余一律按陌生处理（先识别，再决定是否上报主人）。
 *
 * 纯计算、无 IO——联系人集合由 store 读入后作为参数传入，便于单测。
 *
 * @module @deepseek-ai/dsh-mail-bridge/features/trust
 */

/** 信任级别（由高到低）。 */
export type TrustLevel = 'owner' | 'authorized' | 'established' | 'stranger'

/** 信任判定配置。 */
export interface TrustConfig {
  /** 主人邮箱：指令来源与上报去向。 */
  owner: string
  /** 显式授权可直接触发对话的邮箱数组。 */
  allowedSenders: readonly string[]
}

/**
 * 规范化邮箱地址：去空白、转小写，用于比较与索引。
 * @param address - 原始地址（可能带尖括号或显示名残留）。
 */
export function normalizeAddress(address: string): string {
  const angled = address.match(/<([^>]+)>/)
  const bare = (angled?.[1] ?? address).trim().toLowerCase()
  return bare
}

/**
 * 判定来信地址的信任级别。
 * @param from - 来信地址（任意形态）。
 * @param config - 主人与授权数组。
 * @param contacts - 出站建立信任的联系人集合（小写地址）。
 */
export function classifyTrust(
  from: string,
  config: TrustConfig,
  contacts: ReadonlySet<string>,
): TrustLevel {
  const address = normalizeAddress(from)
  if (address.length === 0) return 'stranger'
  if (address === normalizeAddress(config.owner)) return 'owner'
  if (config.allowedSenders.some(item => normalizeAddress(item) === address)) return 'authorized'
  if (contacts.has(address)) return 'established'
  return 'stranger'
}

/** 该信任级别是否允许直接驱动机器（主人/授权/出站建立均允许）。 */
export function canTrigger(level: TrustLevel): boolean {
  return level !== 'stranger'
}

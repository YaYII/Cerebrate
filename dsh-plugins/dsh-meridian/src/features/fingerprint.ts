/**
 * 行为指纹砖块 —— 用语义不变量描述「一段运行行为长什么样」，并支持定位差异。
 *
 * 本文件干什么：把事件序列压成**双层指纹**（结构层 / 标签层）与**可定位的哈希链**，
 * 并比较两个指纹的差异位置。
 * 本文件不干什么：不认识业务、不做判定（判定在 ruler）、不读文件。
 *
 * 为什么要双层（本项目的关键设计，优于「只给一个 digest」的做法）：
 * - **结构层**只取「相位」与「拓扑形状」，因此**改名、改文案不会变**——对应「纯改名不算行为变化」；
 * - **标签层**取活动短标签，因此**改名会变**；
 * - 两层一起看，就能把「行为真的变了」（高置信风险）与「只是换了个名字」（低置信噪音）区分开。
 *   只给单一 digest 的实现无法区分这两者，会把改名的噪音报成风险（告警疲劳），
 *   或者把真实的行为变化淹没在改名噪音里（漏报）。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { RuntimeEvent } from './eventModel'

/** 简短稳定的字符串哈希（FNV-1a 变体，用于指纹链，不作密码学用途）。 */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 结构键：只保留「事件形状」，剔除一切会随文案/参数/环境变化的信息。
 *
 * 保留：相位（phase）、参与者角色的**数量与顺序位置**（即序列中的位置）。
 * 剔除：类名、方法名、标签、耗时、参数、级别。
 *
 * @param event - 运行时事件。
 * @param index - 该事件在序列中的位置（位置本身属结构信息）。
 * @returns 结构键字符串。
 */
export function structureKey(event: RuntimeEvent, index: number): string {
  return `${index}:${event.phase}`
}

/**
 * 标签归一化：把易变值替换为占位符，只留下「文案形状」。
 *
 * 动因（来自真实数据的教训）：真实日志标签形如
 * `核验完成: orderNo=ORD-CONFIRM001, 核验耗时=5ms`——单号与耗时每次运行都不同。
 * 若直接入指纹，**每次跑都会报「标签变化」**，噪音淹没真信号。
 * 归一化后：数值变化不再影响指纹，只有**文案本身被改写（改名/改措辞）**才会。
 *
 * @param label - 原始短标签。
 * @returns 归一化后的标签。
 */
export function normalizeLabel(label: string): string {
  return label
    .replace(/\s+/g, ' ')
    .trim()
    // 十六进制/长 ID（含 UUID、orderNo 一类）
    .replace(/\b[0-9a-fA-F]{8,}\b/g, '<id>')
    // 带连字符的 UUID
    .replace(/\b[0-9a-fA-F-]{16,}\b/g, '<id>')
    // 纯数字与带单位数值（含毫秒）
    .replace(/\b\d+(\.\d+)?(ms|s|MB|KB|次)?\b/g, '<n>')
    // 键值对里的值（保留键名，抹掉值）
    .replace(/=([^\s,，;；]+)/g, '=<v>')
}

/**
 * 标签键：在结构键之外加入**归一化后**的活动短标签与参与者名，因此只对「文案变化」敏感。
 *
 * @param event - 运行时事件。
 * @param index - 该事件在序列中的位置。
 * @returns 标签键字符串。
 */
export function labelKey(event: RuntimeEvent, index: number): string {
  return `${index}:${event.phase}:${normalizeLabel(event.label)}`
}

/** 单个位置的指纹条目。 */
export interface FingerprintEntry {
  /** 位置（0 基）。 */
  index: number
  /** 结构层链式摘要（含此前所有位置）。 */
  structureDigest: string
  /** 标签层链式摘要（含此前所有位置）。 */
  labelDigest: string
  /** 事件短标签（便于人读差异）。 */
  label: string
  /** 证据行号（便于回跳）。 */
  line: number
}

/** 一段运行行为的指纹。 */
export interface BehaviorFingerprint {
  /** 事件数量。 */
  size: number
  /** 结构层整体摘要（对改名不敏感）。 */
  structureDigest: string
  /** 标签层整体摘要（对改名敏感）。 */
  labelDigest: string
  /** 逐位置的链式摘要，用于定位差异。 */
  entries: FingerprintEntry[]
}

/**
 * 构建行为指纹。
 *
 * 采用链式（前缀累积）摘要而非树形摘要：日志事实天然是有序序列，
 * 链式摘要同样具备「任一位置变化即整体变化」的完整性，并能 O(n) 定位首个差异点。
 *
 * @param events - 事件序列（按出现顺序）。
 * @returns 行为指纹。
 */
export function buildFingerprint(events: RuntimeEvent[]): BehaviorFingerprint {
  const entries: FingerprintEntry[] = []
  let structure = 'seed'
  let label = 'seed'
  events.forEach((event, index) => {
    structure = shortHash(`${structure}|${structureKey(event, index)}`)
    label = shortHash(`${label}|${labelKey(event, index)}`)
    entries.push({
      index,
      structureDigest: structure,
      labelDigest: label,
      label: event.label,
      line: event.evidence.line,
    })
  })
  return {
    size: events.length,
    structureDigest: structure,
    labelDigest: label,
    entries,
  }
}

/** 指纹差异的类型。 */
export type FingerprintDeltaKind =
  | 'identical'
  | 'relabeled'
  | 'structure-changed'
  | 'length-changed'

/** 指纹差异结果。 */
export interface FingerprintDelta {
  /** 差异类型。 */
  kind: FingerprintDeltaKind
  /** 人读结论。 */
  summary: string
  /** 首个分歧位置（0 基）；无分歧为 -1。 */
  firstDivergence: number
  /** 两侧在该位置的标签与证据行号（用于回跳核对）。 */
  baseSample: { label: string; line: number } | null
  /** 当前侧在同一位置的标签与证据行号。 */
  currentSample: { label: string; line: number } | null
}

/**
 * 比较两个指纹，区分「只是改名」与「结构真的变了」。
 *
 * @param base - 基线指纹。
 * @param current - 当前指纹。
 * @returns 差异结果（含分歧位置与双向证据）。
 */
export function compareFingerprints(base: BehaviorFingerprint, current: BehaviorFingerprint): FingerprintDelta {
  if (base.structureDigest === current.structureDigest) {
    if (base.labelDigest === current.labelDigest) {
      return {
        kind: 'identical',
        summary: `行为与基线一致（${current.size} 个事件，结构与标签均未变）`,
        firstDivergence: -1,
        baseSample: null,
        currentSample: null,
      }
    }
    const at = firstDivergenceIndex(base, current)
    return {
      kind: 'relabeled',
      summary: `结构未变但标签变化，疑似改名或改文案（低置信，建议人工确认）`,
      firstDivergence: at,
      baseSample: sampleOf(base, at),
      currentSample: sampleOf(current, at),
    }
  }
  if (base.size !== current.size) {
    const at = firstDivergenceIndex(base, current)
    return {
      kind: 'length-changed',
      summary: `事件数量变化：基线 ${base.size} → 当前 ${current.size}（多/少做了步骤）`,
      firstDivergence: at,
      baseSample: sampleOf(base, at),
      currentSample: sampleOf(current, at),
    }
  }
  const at = firstDivergenceIndex(base, current)
  return {
    kind: 'structure-changed',
    summary: `执行结构发生变化（高置信：行为真的变了），首个分歧在第 ${at + 1} 个事件`,
    firstDivergence: at,
    baseSample: sampleOf(base, at),
    currentSample: sampleOf(current, at),
  }
}

/**
 * 找出首个分歧位置。
 *
 * 策略：**先用标签层定位，再用结构层兜底**。
 *
 * 为什么这样分：分类（是改名还是真变化）看结构层，定位（哪一步开始不同）看标签层。
 * 原因是结构层刻意剔除了文案，信息量取决于采集端的「相位丰富度」——
 * 当一批日志全是 `log` 相位时（真实语料里常见），结构层只能表达「长度变了」，
 * 无法指出是哪一步变了；而标签层能精确指出。两者分工，各取所长。
 *
 * @param base - 基线指纹。
 * @param current - 当前指纹。
 * @returns 首个分歧位置（0 基）；无法定位时返回 -1。
 */
function firstDivergenceIndex(base: BehaviorFingerprint, current: BehaviorFingerprint): number {
  const labelAt = scanDivergence(base, current, 'labelDigest')
  if (labelAt >= 0) return labelAt
  return scanDivergence(base, current, 'structureDigest')
}

/** 扫描指定层的首个不一致位置；序列长度不同则返回较短长度处。 */
function scanDivergence(
  base: BehaviorFingerprint,
  current: BehaviorFingerprint,
  field: 'structureDigest' | 'labelDigest',
): number {
  const limit = Math.min(base.entries.length, current.entries.length)
  for (let i = 0; i < limit; i += 1) {
    if (base.entries[i][field] !== current.entries[i][field]) return i
  }
  return base.entries.length === current.entries.length ? -1 : limit
}

/** 取某位置的样本（越界返回 null）。 */
function sampleOf(fingerprint: BehaviorFingerprint, index: number): { label: string; line: number } | null {
  if (index < 0 || index >= fingerprint.entries.length) return null
  const entry = fingerprint.entries[index]
  return { label: entry.label, line: entry.line }
}

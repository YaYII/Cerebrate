/**
 * 热点归因砖块 —— 把「带耗时的运行时事实」聚合成可定位的优化证据。
 *
 * 本文件干什么：按活动归并耗时，给出 count / total / p50 / p95 / max 与采样证据。
 * 本文件不干什么：不解析日志、不做判定、不认识具体业务。
 *
 * 为什么需要它（用户定的第二战场）：线上排查要的是**可归因的证据**，不是经验猜测。
 * 单条日志只能告诉你「这一次花了 24ms」；聚合才能回答
 * 「**时间主要花在哪、最差的那批有多差、证据在哪几行**」。
 *
 * 归并键用「归一化标签」而非原始标签：同一活动每次运行的数值/单号都不同，
 * 不归一化会把每次执行都当成不同热点（等于没有聚合）。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { Evidence, RuntimeEvent } from './eventModel'
import { normalizeLabel } from './fingerprint'

/** 单个热点。 */
export interface Hotspot {
  /** 归并键（归一化后的活动名）。 */
  key: string
  /** 出现次数。 */
  count: number
  /** 累计耗时（毫秒）——回答「时间主要花在哪」。 */
  totalMs: number
  /** 最大耗时（毫秒）。 */
  maxMs: number
  /** 中位数耗时（毫秒）。 */
  p50Ms: number
  /** 尾部耗时（毫秒，最近秩法近似）——回答「最差的那批有多差」。 */
  p95Ms: number
  /** 采样证据（最多 3 条，含行号）。 */
  evidence: Evidence[]
}

/** 热点报告。 */
export interface HotspotReport {
  /** 参与统计的耗时样本数（事件数 + 分段数）。 */
  timedEvents: number
  /** 事件耗时之和（毫秒）——**不含分段**，口径是真实墙钟时间。 */
  totalMs: number
  /**
   * 分段耗时之和（毫秒）。
   *
   * **为什么与 totalMs 分开**：分段是事件内部阶段的拆分，若把「事件总耗时」与
   * 「它的各段耗时」同时累加，就会重复计算（实测让合计虚高一倍）。
   * 两者必须分列，百分比才有意义。
   */
  segmentTotalMs: number
  /** 按「累计耗时」排序的热点（时间花在哪）。 */
  byTotal: Hotspot[]
  /** 按「p95」排序的热点（尾部最差在哪）。 */
  byTail: Hotspot[]
  /** 口径与可信度说明（必须回显给消费者）。 */
  note: string
}

/** 计算分位数（最近秩法，无需插值；样本量小也稳定）。 */
function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

/**
 * 聚合热点。
 *
 * @param events - 运行时事件序列。
 * @param options - `top` 控制每张榜的条数（默认 10）。
 * @returns 热点报告（含口径说明）。
 */
export function computeHotspots(events: RuntimeEvent[], options: { top?: number } = {}): HotspotReport {
  const top = options.top ?? 10
  const groups = new Map<string, { durations: number[]; evidence: Evidence[] }>()
  let totalMs = 0
  let timedEvents = 0

  /** 把一个耗时样本并入归并组。 */
  const add = (key: string, ms: number, evidence: Evidence): void => {
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { durations: [ms], evidence: [evidence] })
      return
    }
    group.durations.push(ms)
    if (group.evidence.length < 3) group.evidence.push(evidence)
  }

  let segmentTotalMs = 0
  for (const event of events) {
    const label = normalizeLabel(event.label)
    if (event.durationMs !== null && event.durationMs >= 0) {
      timedEvents += 1
      totalMs += event.durationMs
      add(label, event.durationMs, event.evidence)
    }
    // 分段耗时单独计入（并单独累加，避免与事件总耗时重复计算）：段名进归并键 → 回答「慢在哪一段」
    for (const segment of event.segments) {
      timedEvents += 1
      segmentTotalMs += segment.ms
      add(`${label} · ${segment.name}`, segment.ms, event.evidence)
    }
  }

  const hotspots: Hotspot[] = []
  for (const [key, group] of groups) {
    const sorted = [...group.durations].sort((a, b) => a - b)
    const sum = sorted.reduce((acc, value) => acc + value, 0)
    hotspots.push({
      key,
      count: sorted.length,
      totalMs: sum,
      maxMs: sorted[sorted.length - 1] ?? 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      evidence: group.evidence,
    })
  }

  // 各热点项互不重叠（事件项与分段项分属不同层），故占比分母取两者之和
  const byTotal = [...hotspots].sort((a, b) => b.totalMs - a.totalMs).slice(0, top)
  const byTail = [...hotspots].sort((a, b) => b.p95Ms - a.p95Ms || b.maxMs - a.maxMs).slice(0, top)
  return {
    timedEvents,
    totalMs,
    segmentTotalMs,
    byTotal,
    byTail,
    note:
      timedEvents === 0
        ? '本次事实中没有任何带耗时的事件——**不能据此得出「没有性能问题」**，请先确认接入声明的规则是否覆盖了耗时字段。'
        : `统计口径：事件耗时合计 ${totalMs}ms（不含分段）＋分段耗时合计 ${segmentTotalMs}ms，` +
          `共 ${timedEvents} 个耗时样本，按归一化活动名归并；` +
          'p95 采用最近秩法（样本少时偏保守）。归并键已抹掉数值与单号，因此同一活动的多次执行会被合并统计；' +
          '「活动 · 段名」形式的热点来自事件内的分段耗时，用于回答「慢在哪一段」。',
  }
}

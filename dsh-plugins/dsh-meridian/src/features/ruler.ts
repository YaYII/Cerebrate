/**
 * 标尺砖块 —— 把「AI 声明的意图」与「运行期事实」对比，产出可复核的判定。
 *
 * 本文件干什么：编译意图声明、按序匹配事实、产出五类偏离发现（每条带证据）。
 * 本文件不干什么：不解析日志、不做指纹比较（那在 fingerprint）、不认识具体业务。
 *
 * 偏离类型沿用流程挖掘的形式化语义（调研报告 §3.3），保证判定词汇可被业界理解：
 * - `move-on-model`（模型有、日志无）= **漏做环节**；
 * - `move-on-log`（日志有、模型无）= **越权/额外路径**；
 * - `stuck` = 未到达期望终态（**单据卡住**）；
 * - `order-deviation` = 顺序偏离；
 * - `failed-step` = 期望成功的环节实际失败。
 *
 * 不可协商的约束：**事实不可信时拒绝判定**（status = inconclusive）。
 * 宁可说「我判不了」，也不能在残缺事实上给出「通过」——否则标尺就失去了权威性。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { CaseFacts, Coverage, CoverageVerdict, Evidence, EventPhase, RuntimeEvent } from './eventModel'

/** 事实匹配声明：三者皆为可选条件，全部满足才算命中。 */
export interface FactMatcher {
  /** 短标签包含（大小写不敏感的子串匹配）。 */
  labelContains?: string
  /** 语义相位。 */
  phase?: EventPhase
  /** 日志级别精确匹配。 */
  level?: string
}

/** 期望中的一步。 */
export interface ExpectedStep {
  /** 人读步骤名（业务语义，出现在判定里）。 */
  name: string
  /** 匹配规则。 */
  match: FactMatcher
  /** 是否允许缺失（默认不允许，缺失即「漏做环节」）。 */
  optional?: boolean
  /** 是否期望该步不失败（默认 false，仅记录）。 */
  mustSucceed?: boolean
}

/** 意图声明：AI 在动手前/动手后声明「我认为这段代码应该怎么运行」。 */
export interface Intent {
  /** 意图名（出现在判定里）。 */
  name: string
  /**
   * 适用前提：只有当案例事实中出现命中该声明的事件时，本意图才对该案例生效。
   *
   * **为什么必须有它（来自真实数据的教训）**：同一条「核验成功流程」意图若套用到
   * 「核验拒绝」分支上，会把「没有写主档」误报成"漏做环节"——而拒绝分支本来就不该写主档。
   * 误报比漏报更危险（告警疲劳）。因此意图必须与**场景/分支**绑定，
   * 不匹配的案例判为 `out-of-scope`（跳过），而不是硬判。
   */
  appliesWhen?: FactMatcher
  /** 期望的活动序列（**顺序敏感**）。 */
  expect: ExpectedStep[]
  /** 期望终态；缺失则该案例判为「卡住」。 */
  expectEnd?: FactMatcher
  /** 允许出现的额外事实（白名单），避免把已知噪音报成越权。 */
  allow?: FactMatcher[]
}

/** 判定发现（偏离）。 */
export type FindingKind = 'move-on-model' | 'move-on-log' | 'stuck' | 'order-deviation' | 'failed-step'

/** 单条判定发现。 */
export interface Finding {
  /** 偏离类型。 */
  kind: FindingKind
  /** 严重度。 */
  severity: 'high' | 'medium' | 'low'
  /** 人读说明。 */
  message: string
  /** 事实侧证据（可回跳日志行）。 */
  evidence: Evidence[]
  /** 期望侧描述（若有）。 */
  expected: string | null
}

/** 判定结论。 */
export interface Verdict {
  /** 意图名。 */
  intent: string
  /** 案例标识。 */
  caseId: string
  /** 结论：通过 / 偏离 / 失败 / 无法判定 / 超出本意图适用范围。 */
  status: 'pass' | 'deviated' | 'failed' | 'inconclusive' | 'out-of-scope'
  /** 偏离发现列表。 */
  findings: Finding[]
  /** 命中的期望步骤名（按序）。 */
  matched: string[]
  /** 未命中的期望步骤名。 */
  missing: string[]
  /**
   * 期望活动的重复次数（>1 才列出）。
   *
   * **为什么单列**：重复执行业务活动是常态（一张单据被改 5 次），既不是偏离也不该被丢弃——
   * 它是有效的业务信号（改得多说明在反复调整）。早期实现把重复当成「额外路径」误报，
   * 这正是"善意缺失的规则会产生告警疲劳"的又一例。
   */
  repeats: Array<{ step: string; count: number }>
  /** 判定依据说明（含事实可信度）。 */
  basis: string
}

/** 判断一个事实是否命中匹配声明。 */
export function matches(event: RuntimeEvent, matcher: FactMatcher): boolean {
  if (matcher.phase !== undefined && event.phase !== matcher.phase) return false
  if (matcher.level !== undefined && event.level.toUpperCase() !== matcher.level.toUpperCase()) return false
  if (matcher.labelContains !== undefined && !event.label.toLowerCase().includes(matcher.labelContains.toLowerCase())) {
    return false
  }
  return true
}

/** 把匹配声明渲染成人读文本（用于判定里的「期望」字段）。 */
export function describeMatcher(matcher: FactMatcher): string {
  const parts: string[] = []
  if (matcher.phase !== undefined) parts.push(`相位=${matcher.phase}`)
  if (matcher.labelContains !== undefined) parts.push(`标签含「${matcher.labelContains}」`)
  if (matcher.level !== undefined) parts.push(`级别=${matcher.level}`)
  return parts.length === 0 ? '（任意事实）' : parts.join(' 且 ')
}

/**
 * 对单个案例做判定。
 *
 * @param intent - 意图声明。
 * @param facts - 该案例的事实。
 * @param coverageVerdict - 摄取阶段的覆盖度结论；为 `failed` 时直接返回 inconclusive。
 * @returns 判定结论。
 */
export function judgeCase(intent: Intent, facts: CaseFacts, coverageVerdict: CoverageVerdict): Verdict {
  const base: Pick<Verdict, 'intent' | 'caseId'> = { intent: intent.name, caseId: facts.caseId }
  if (coverageVerdict === 'failed') {
    return {
      ...base,
      status: 'inconclusive',
      findings: [],
      matched: [],
      missing: intent.expect.map((step) => step.name),
      repeats: [],
      basis: '事实不可信（摄取覆盖度判定为 failed）：**拒绝判定**，请先修复日志格式声明或采集链路。',
    }
  }
  // 适用前提不满足 → 明确跳过，绝不硬判（避免跨分支误报）
  if (intent.appliesWhen !== undefined && !facts.events.some((event) => matches(event, intent.appliesWhen as FactMatcher))) {
    return {
      ...base,
      status: 'out-of-scope',
      findings: [],
      matched: [],
      missing: [],
      repeats: [],
      basis: `本案例不满足该意图的适用前提（${describeMatcher(intent.appliesWhen)}）：跳过判定，不做任何结论。`,
    }
  }

  const findings: Finding[] = []
  const matched: string[] = []
  const missing: string[] = []
  const usedIndexes = new Set<number>()
  /** 每条期望步骤的实际命中次数（用于重复计数）。 */
  const hitCounts = new Map<string, number>()
  const recordHit = (name: string): void => {
    hitCounts.set(name, (hitCounts.get(name) ?? 0) + 1)
  }
  let cursor = 0
  let lastMatchedAt = -1

  // ① 按序匹配期望步骤（贪心向前扫描，保证「顺序」可被检验）
  for (const step of intent.expect) {
    let found = -1
    for (let i = cursor; i < facts.events.length; i += 1) {
      if (matches(facts.events[i], step.match)) {
        found = i
        break
      }
    }
    if (found < 0) {
      // 顺序敏感匹配失败时，退回全局扫描，以区分「漏做」与「顺序错」
      const anywhere = facts.events.findIndex((event) => matches(event, step.match))
      if (anywhere >= 0) {
        findings.push({
          kind: 'order-deviation',
          severity: 'medium',
          message: `步骤「${step.name}」出现顺序与期望不符（在第 ${anywhere + 1} 个事实出现，期望在第 ${cursor + 1} 个之后）`,
          evidence: [facts.events[anywhere].evidence],
          expected: describeMatcher(step.match),
        })
        matched.push(step.name)
        usedIndexes.add(anywhere)
        recordHit(step.name)
        continue
      }
      if (step.optional === true) continue
      missing.push(step.name)
      findings.push({
        kind: 'move-on-model',
        severity: 'high',
        message: `漏做环节：期望的步骤「${step.name}」在事实中不存在`,
        evidence: [],
        expected: describeMatcher(step.match),
      })
      continue
    }
    if (found < lastMatchedAt) {
      findings.push({
        kind: 'order-deviation',
        severity: 'medium',
        message: `步骤「${step.name}」的顺序提前`,
        evidence: [facts.events[found].evidence],
        expected: describeMatcher(step.match),
      })
    }
    matched.push(step.name)
    usedIndexes.add(found)
    recordHit(step.name)
    cursor = found + 1
    lastMatchedAt = found
    const event = facts.events[found]
    if (step.mustSucceed === true && event.ok === false) {
      findings.push({
        kind: 'failed-step',
        severity: 'high',
        message: `步骤「${step.name}」期望成功，实际失败`,
        evidence: [event.evidence],
        expected: '成功（ok=true）',
      })
    }
  }

  // ② 未被任何期望或白名单覆盖的事实 = 额外路径（move-on-log）
  const allowed = intent.allow ?? []
  for (let i = 0; i < facts.events.length; i += 1) {
    if (usedIndexes.has(i)) continue
    const event = facts.events[i]
    if (allowed.some((matcher) => matches(event, matcher))) continue
    // 期望活动的**重复出现**：既不算额外路径，也不能丢——重复次数是有效业务信号。
    // ⚠️ 本判断必须先于「phase === 'log' 跳过」：业务活动日志常落在 log 相位，
    //    若放在其后，重复计数会被相位过滤挡掉（实测踩过，回归测试当场抓到）。
    const repeatedStep = intent.expect.find((step) => matches(event, step.match))
    if (repeatedStep !== undefined) {
      recordHit(repeatedStep.name)
      continue
    }
    if (event.phase === 'log') continue // 普通日志不作为行为路径判定对象
    findings.push({
      kind: 'move-on-log',
      severity: 'medium',
      message: `额外路径：事实「${event.label}」不在期望之内，也不在白名单中`,
      evidence: [event.evidence],
      expected: null,
    })
  }

  // ③ 终态检查：未到达期望终态 = 卡住
  if (intent.expectEnd !== undefined) {
    const reached = facts.events.some((event) => matches(event, intent.expectEnd as FactMatcher))
    if (!reached) {
      const tail = facts.events.slice(-3).map((event) => event.evidence)
      findings.push({
        kind: 'stuck',
        severity: 'high',
        message: `未到达期望终态（${describeMatcher(intent.expectEnd)}）：流程可能中断或未闭环`,
        evidence: tail,
        expected: describeMatcher(intent.expectEnd),
      })
    }
  }

  const repeats: Array<{ step: string; count: number }> = []
  for (const [step, count] of hitCounts) {
    if (count > 1) repeats.push({ step, count })
  }

  const hasHigh = findings.some((item) => item.severity === 'high')
  const status: Verdict['status'] = findings.length === 0 ? 'pass' : hasHigh ? 'failed' : 'deviated'
  const coverageNote = coverageVerdict === 'degraded' ? '（注意：事实存在少量未识别行，结论为部分可信）' : ''
  return {
    ...base,
    status,
    findings,
    matched,
    missing,
    repeats,
    basis:
      findings.length === 0
        ? `全部 ${matched.length} 个期望步骤按序命中，且未发现额外路径与失败步骤。${coverageNote}`
        : `命中 ${matched.length}/${intent.expect.length} 个期望步骤，发现 ${findings.length} 处偏离。${coverageNote}`,
  }
}

/**
 * 覆盖度对判定的影响说明（供工具层直接回显）。
 *
 * @param coverage - 摄取覆盖度。
 * @returns 人读说明。
 */
export function explainCoverage(coverage: Coverage): string {
  const percent = (coverage.ratio * 100).toFixed(2)
  return `解析率 ${percent}%｜记录 ${coverage.recordLines} 行｜续行 ${coverage.continuationLines} 行｜漏网 ${coverage.orphanLines} 行`
}

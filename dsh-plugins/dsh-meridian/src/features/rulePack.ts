/**
 * 规则包砖块 —— 把「日志消息的含义」外置为声明式规则，而不是散落在解析代码的 if 分支里。
 *
 * 本文件干什么：定义规则与规则包的数据结构、编译规则正则、渲染标签模板。
 * 本文件不干什么：不含任何项目专属规则（那些放在 `src/packs/`，是数据不是代码）。
 *
 * 设计动因：被观测项目原有解析器把「格式」与「语义」一起硬编码在 15 条正则里，
 * 任何一端文案调整都会静默破坏另一端。此处把两者都变成**可版本化的声明**，
 * 并用覆盖度指标在失效时报警。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { EventPhase } from './eventModel'
import { compileFormat, type CompiledFormat, type FormatSpec } from './logFormat'

/** 单条消息规则：命中即产出一条事件。 */
export interface MessageRule {
  /** 规则名（出现在产物里，便于定位是哪条规则产出的事实）。 */
  name: string
  /** 语义相位。 */
  phase: EventPhase
  /** 消息体正则（须与消息体整体匹配；可使用具名捕获组）。 */
  pattern: string
  /** 短标签模板，`{组名}` 会被替换；缺省时取整条消息。 */
  label?: string
  /** 细节模板，`{组名}` 会被替换；缺省时取整条消息。 */
  detail?: string
  /** 耗时字段名（毫秒）。 */
  durationField?: string
  /**
   * 分段耗时抽取声明（可选）：对消息体做**全局**匹配，逐段抽出名称与毫秒值。
   *
   * 用于把既有日志里的「分段耗时」文本（如 `落库(主档+缓冲)=24ms`）直接变成可归因证据，
   * 无需改动被观测系统的采集端。
   */
  segments?: {
    /** 全局正则（须带 g 语义：由实现以 exec 循环消费）。 */
    pattern: string
    /** 段名所在的具名捕获组。 */
    nameGroup: string
    /** 毫秒值所在的具名捕获组。 */
    valueGroup: string
    /** 需要忽略的段名（如汇总行「合计」——它不是阶段，混进来会污染热点排行）。 */
    ignore?: string[]
  }
  /** 成功判定字段名；与 `okEquals` 比较。 */
  okField?: string
  /** 成功判定期望值。 */
  okEquals?: string
  /** 参与者归属：`logger` = 取 logger 简名；`stack` = 取调用栈顶。 */
  actor?: 'logger' | 'stack'
  /**
   * 案例标识来源字段名：命中规则的具名捕获组名，其值将作为事件 `caseId`。
   *
   * **为什么需要它**：与语言相关。Java/logback 把 traceId 放在**行首的 MDC 段**
   * （`[%X{traceId}]`），可从格式里直接取；而 PHP/Laravel 把它放在**消息体的 JSON 上下文里**
   * （`API Request {"trace_id":"..."}`），只能由规则从消息中抽取。
   * 没有这个字段，「按案例聚合」在 PHP 生态里就不成立。
   */
  caseIdField?: string
  /**
   * 业务对象标识来源字段名（具名捕获组）：如单据号 `app_no`。
   * 用于把「技术案例」与「业务案例」分开建模（见 RuntimeEvent.objectId 的说明）。
   */
  objectIdField?: string
  /** 命中时是否为调用栈压栈。 */
  stackPush?: boolean
  /** 命中时是否为调用栈弹栈。 */
  stackPop?: boolean
}

/** 一种被观测系统的接入声明：格式 + 规则。 */
export interface RulePack {
  /** 接入名（如 `dsedt-java-logback`）。 */
  name: string
  /**
   * 该系统的日志格式候选（可多种运行态并存，如生产态与测试态、文本与结构化）。
   *
   * 支持两种形态：文本 pattern（logback/Monolog）与结构化 JSON Lines（pino/structlog/zap 等）。
   */
  formats: FormatSpec[]
  /** 消息规则（按声明顺序匹配，先命中先产出）。 */
  rules: MessageRule[]
  /**
   * 包级业务对象抽取：对**每一条**消息统一尝试（可选）。
   *
   * 动因（来自真实生产语料）：业务对象标识（如 `orderNo`）常出现在多种日志行里
   * （建单、核验完成、主档收敛、异常…），逐条规则声明既繁琐又容易漏。
   * 包级声明一次即可让所有相关事件获得业务对象维度，从而让「一张单据的一生」成立。
   *
   * 优先级：规则级 `objectIdField` 命中时优先，否则回落到包级抽取。
   */
  objectId?: { pattern: string; group: string }
}

/** 编译后的规则。 */
export interface CompiledRule extends MessageRule {
  /** 编译所得正则。 */
  regex: RegExp
}

/** 编译后的规则包。 */
export interface CompiledRulePack {
  /** 原始规则包（原样保留，用于产物标注与版本比对）。 */
  pack: RulePack
  /** 编译后的格式候选。 */
  formats: CompiledFormat[]
  /** 编译后的规则。 */
  rules: CompiledRule[]
}

/**
 * 编译规则包：把格式声明与消息规则一次性编译为正则。
 *
 * @param pack - 规则包声明。
 * @returns 编译结果。
 * @throws 当格式声明非法（缺消息体转换词）或规则正则非法时抛错——**接入声明的错误必须立刻暴露**。
 */
export function compileRulePack(pack: RulePack): CompiledRulePack {
  const formats = pack.formats.map((item) => compileFormat(item))
  const rules = pack.rules.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern) }))
  return { pack, formats, rules }
}

/**
 * 渲染模板：把 `{组名}` 替换为捕获组的值。
 *
 * @param template - 模板文本。
 * @param groups - 正则具名捕获组。
 * @returns 渲染结果；缺失的组替换为空串（不抛错，避免因文案差异中断解析）。
 */
export function renderTemplate(template: string, groups: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_all, key: string) => groups[key] ?? '')
}

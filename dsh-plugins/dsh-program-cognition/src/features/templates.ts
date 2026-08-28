/**
 * 埋点模板生成器 —— 根据扫描档案决定「在哪里埋、埋什么」。
 *
 * 覆盖范围（决策 #5）：kind ∈ {brick, service} 的函数全部生成入口/出口埋点，
 * 函数体内的副作用调用点生成状态变更埋点。
 * 脱敏在生成端完成：参数名命中黑名单时以字面量 `***` 代替变量引用，
 * 从源头避免敏感值进入埋点代码。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import type { ScanResult } from './scanner'
import { isRedactKey, shortId } from './redact'

/** 埋点时机。 */
export type LogPhase = 'entry' | 'exit' | 'state-change'

/** 一条日志埋点配置。 */
export interface LogPoint {
  id: string
  /** 目标：文件相对路径:函数名。 */
  target: string
  /** 函数分类（决定 [brick]/[service] 前缀与注入键）。 */
  kind: 'brick' | 'service'
  /** 埋点时机。 */
  phase: LogPhase
  /** 日志级别。 */
  level: 'info' | 'debug' | 'warn'
  /** 日志模板（运行时填充，含参数摘要）。 */
  template: string
  /** 需脱敏的参数名。 */
  redact: string[]
  /** 状态变更的目标词（state-change 时）。 */
  sideEffect?: string
}

/** 埋点生成选项。 */
export interface LogPointOptions {
  /** 限定范围：'auto'（全部）| 'file:相对路径' | 'function:文件相对路径:函数名'。 */
  scope?: string
}

/** 生成状态变更埋点时的副作用词表（与 scanner 保持一致）。 */
const SIDE_EFFECT_PATTERNS = [
  'fetch(', 'axios', 'writeFile', 'readFile', 'appendFile', 'console.',
  'query', 'insert', 'update', 'delete', 'save(', 'remove(', 'create',
  'Repository', 'Model', 'Schema', 'process.', 'globalThis',
]

/** 生成入口/出口埋点的候选代码行（用于状态变更定位）。 */
export const STATE_CHANGE_PATTERNS = SIDE_EFFECT_PATTERNS

/**
 * 判断函数是否命中埋点范围（kind ∈ {brick, service}）。
 * @param kind - 函数分类。
 * @returns 是否埋点。
 */
export function isInstrumentable(kind: string): boolean {
  return kind === 'brick' || kind === 'service'
}

/**
 * 生成入口埋点模板。
 * @param kind - 函数分类（决定前缀 [brick]/[service]）。
 * @param name - 函数名。
 * @param inputs - 参数名列表（黑名单参数以 *** 字面量占位）。
 * @returns { template, redact }。
 */
export function entryTemplate(kind: string, name: string, inputs: string[]): { template: string; redact: string[] } {
  const redact = inputs.filter(isRedactKey)
  const safeInputs = inputs.map(a => isRedactKey(a) ? `${a}: ***` : `${a}: {${a}}`)
  return { template: `[${kind}] ${name} 入参 {${safeInputs.join(', ')}}`, redact }
}

/**
 * 生成出口埋点模板（不含返回值摘要，v1 仅记录结束与耗时配对）。
 * @param kind - 函数分类。
 * @param name - 函数名。
 * @returns 模板文本。
 */
export function exitTemplate(kind: string, name: string): string {
  return `[${kind}] ${name} 结束`
}

/**
 * 为扫描结果生成全部埋点配置。
 * @param scan - 扫描结果。
 * @param options - 生成选项（scope 限定范围）。
 * @returns 埋点配置列表。
 */
export function generateLogPoints(scan: ScanResult, options: LogPointOptions = {}): LogPoint[] {
  const scope = options.scope ?? 'auto'
  const points: LogPoint[] = []
  const scopeMatch = (file: string, name: string): boolean => {
    if (scope === 'auto') return true
    if (scope.startsWith('file:')) return file === scope.slice(5)
    if (scope.startsWith('function:')) {
      const [sf, fn] = [scope.slice(9).split(':')[0], scope.slice(9).split(':')[1]]
      return file === sf && name === fn
    }
    return true
  }
  for (const fn of scan.functions) {
    if (!isInstrumentable(fn.kind) || !scopeMatch(fn.file, fn.name)) continue
    const id = `${fn.file}:${fn.name}`
    const kind = fn.kind === 'brick' ? 'brick' : 'service'
    const { template, redact } = entryTemplate(kind, fn.name, fn.inputs)
    points.push({ id: shortId(id + ':entry'), target: id, kind, phase: 'entry', level: 'info', template, redact })
    points.push({ id: shortId(id + ':exit'), target: id, kind, phase: 'exit', level: 'info', template: exitTemplate(kind, fn.name), redact: [] })
    // 状态变更埋点：函数体内每个副作用词命中行（由 instrument 定位行号，此处只登记词）
    for (const word of fn.sideEffects) {
      if (SIDE_EFFECT_PATTERNS.some(p => word === p.replace(/\W+$/, ''))) {
        points.push({
          id: shortId(id + ':state:' + word),
          target: id,
          kind,
          phase: 'state-change',
          level: 'info',
          template: `[state] ${fn.name} 调用 ${word}`,
          redact: [],
          sideEffect: word,
        })
      }
    }
  }
  return points
}

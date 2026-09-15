/**
 * 日志格式砖块 —— 把「声明的日志格式」编译成解析器，而不是把格式硬编码进正则。
 *
 * 本文件干什么：把 logback pattern 这类**格式声明**编译为正则 + 语义字段映射，
 * 并提供逐行解析；解析失败不抛异常、只记为空缺，由上层统计覆盖率。
 * 本文件不干什么：不认识任何业务词汇、不判断日志含义、不读文件。
 *
 * 设计动因（有实证）：被观测项目原有解析器把 logback pattern 硬编码成一条正则，
 * 实测在真实语料上命中 0/144 行（格式一变即静默失效，且无人知晓）。
 * 因此本砖块把「格式」外置为声明，并强制上层披露覆盖率。
 *
 * @module @deepseek-ai/dsh-meridian
 */

/** 解析出的单条日志记录（结构化字段）。 */
export interface ParsedRecord {
  /** 原文件行号（1 基），作为证据锚点。 */
  line: number
  /** 原始整行文本，作为证据原文。 */
  raw: string
  /** 时间片段（按声明格式截取，未声明则为空串）。 */
  time: string
  /** 日志级别，规范化为大写。 */
  level: string
  /** 日志记录器名（通常是类全名）。 */
  logger: string
  /** 消息体（可能已合并续行）。 */
  message: string
  /** 线程名（未声明则为空串）。 */
  thread: string
  /** 链路标识（未声明或为空则为空串）。 */
  traceId: string
  /** 业务对象标识（JSON Lines 可直接给出；文本格式由规则层抽取）。 */
  objectId: string
}

/** 结构化日志（JSON Lines）的字段映射；未声明时按常见别名自动识别。 */
export interface JsonFieldMap {
  time?: string
  level?: string
  message?: string
  logger?: string
  caseId?: string
  objectId?: string
}

/** 格式声明的两种形态。 */
export type FormatSpec =
  | { name: string; declaration: string }
  | { name: string; kind: 'json'; fields?: JsonFieldMap }

/** 编译后的格式：行格式或结构化（JSON Lines）。 */
export interface CompiledFormat {
  /** 格式名（用于报错与产物标注）。 */
  readonly name: string
  /** 格式种类：`pattern`（logback/Monolog 文本）或 `json`（JSON Lines）。 */
  readonly kind: 'pattern' | 'json'
  /** 原始声明文本（pattern 形态保留原文；json 形态为可读描述）。 */
  readonly declaration: string
  /** 行格式正则（kind=pattern 时有效）。 */
  readonly regex: RegExp
  /** 结构化字段映射（kind=json 时有效）。 */
  readonly fields: JsonFieldMap
}

/**
 * JSON Lines 的常见字段别名。
 *
 * 动因：**结构化日志是跨语言的公共形态**——pino/bunyan(Node)、structlog(Python)、
 * zap/logrus(Go)、logstash-encoder(Java) 都产出单行 JSON，只是键名各不相同。
 * 与其为每个库写一份声明，不如给一张别名表，让「一份声明覆盖多个生态」。
 */
const JSON_ALIASES: Readonly<Record<keyof JsonFieldMap, readonly string[]>> = {
  time: ['time', 'at', 'timestamp', 'ts', '@timestamp', 'date', 'datetime'],
  level: ['level', 'lvl', 'severity', 'level_name', 'levelname'],
  message: ['message', 'msg', 'event', 'text'],
  logger: ['logger', 'name', 'category', 'module', 'component', 'service'],
  caseId: ['trace_id', 'traceId', 'request_id', 'requestId', 'correlation_id', 'x_trace_id'],
  objectId: ['app_no', 'order_no', 'orderNo', 'biz_id', 'object_id', 'doc_no'],
}

/** pino/bunyan 的数字级别 → 名称（Node 生态常见）。 */
const NUMERIC_LEVELS: Readonly<Record<number, string>> = {
  10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL',
}

/** logback 日期格式 → 正则片段的映射（只覆盖工程上真实出现的几种）。 */
const DATE_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['yyyy-MM-dd HH:mm:ss.SSS', '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}'],
  ['yyyy-MM-dd HH:mm:ss', '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}'],
  // Python logging 的 asctime 用逗号分隔毫秒，与 Java/PHP 的点号不同（实测差异）
  ['yyyy-MM-dd HH:mm:ss,SSS', '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3}'],
  ['HH:mm:ss.SSS', '\\d{2}:\\d{2}:\\d{2}\\.\\d{3}'],
  ['HH:mm:ss', '\\d{2}:\\d{2}:\\d{2}'],
]

/**
 * 日志级别候选（顺序无关，正则用交替匹配）。
 *
 * 刻意同时收录两套生态的写法：logback 用 `WARN`，Monolog(PHP) 用 `WARNING`，
 * 另有 `NOTICE/CRITICAL/ALERT/EMERGENCY`。少一个就会让整批日志静默解析失败——
 * 实测踩过：113 条慢查询日志因 `WARNING` 未收录而全部漏解析。
 */
const LEVEL_PATTERN = 'TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|CRITICAL|ALERT|EMERGENCY|FATAL'

/** 转义正则元字符，用于把格式声明里的字面量安全嵌入正则。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把字面量里的空格放宽为 `\s+`。
 *
 * 动因：不同运行态的日志对齐方式不同（如 `%-5level` 的填充空格数不同），
 * 若按字面空格严格匹配，同一份声明在另一种运行态下会零命中——这正是被观测项目踩过的坑。
 */
function spacify(literal: string): string {
  return literal.replace(/ +/g, '\\s+')
}

/** 把 logback 的日期格式转成正则片段；未收录的格式退化为宽松匹配。 */
function dateToRegExp(dateFormat: string): string {
  for (const [key, value] of DATE_PATTERNS) {
    if (dateFormat.trim() === key) return value
  }
  return '\\S+(?: \\S+)?'
}

/**
 * 把 Monolog（PHP/Laravel）风格的格式声明翻译为内部通用写法。
 *
 * 动因：**运行时态是跨语言的，格式声明也必须跨生态**。
 * logback 用 `%d{...}`/`%msg`，Monolog 用 `%datetime%`/`%message%`，
 * 二者只是书写差异，语义完全对应；解析器不该为生态分叉。
 *
 * `%context%` 与 `%extra%` 会被安全地忽略：Monolog 把上下文**追加在消息之后**，
 * 由 `%message%` 一并捕获，随后交由规则层从消息里抽取结构化字段（含 trace_id）。
 *
 * @param declaration - 原始格式声明。
 * @returns 通用写法声明。
 */
export function translateMonolog(declaration: string): string {
  const map: ReadonlyArray<readonly [RegExp, string]> = [
    [/%datetime%|%datetime\{[^}]*\}%/g, '%d{yyyy-MM-dd HH:mm:ss}'],
    [/%channel%/g, '%logger'],
    [/%level_name%/g, '%level'],
    [/%message%/g, '%msg'],
  ]
  let result = declaration
  for (const [pattern, replacement] of map) result = result.replace(pattern, replacement)
  // 上下文与额外字段交由消息体承载
  result = result.replace(/%context%|%extra%/g, '')
  return result.replace(/\s+$/, '')
}

/**
 * 编译一段日志格式声明。
 *
 * 支持两种生态的书写：logback（`%d{...}` / `%thread` / `%X{key}` / `%-5level` / `%logger{36}` / `%msg`）
 * 与 Monolog（`%datetime%` / `%channel%` / `%level_name%` / `%message%`）。
 *
 * @param name - 格式名，用于产物标注（如 `ihm2-laravel`）。
 * @param declaration - 格式声明原文。
 * @returns 编译后的格式对象。
 * @throws 当声明中缺少消息体转换词时抛错——没有消息体的日志无法建立事实。
 */
export function compileLogFormat(name: string, declaration: string): CompiledFormat {
  const rest = translateMonolog(declaration)
  const parts: string[] = []
  let hasMessage = false
  // 逐个转换词扫描：%[修饰符]{参数}?转换字符
  const conversion = /%(?:-?[\d.]*)?([a-zA-Z]+)(?:\{([^}]*)\})?/g
  let cursor = 0
  let match = conversion.exec(rest)
  while (match !== null) {
    let literal = rest.slice(cursor, match.index)
    const word = match[1]
    const arg = match[2] ?? ''
    // 形如 [%thread] / [%X{traceId}]：方括号在声明里是字面量，但字段组需要它们来定界。
    // 做法：从字面量里摘掉方括号，改由字段组产出——否则会出现 \[\[ 双括号（实测踩过）。
    // ⚠️ 仅对「自己产出方括号」的转换词成立；像 [%datetime%] 这种由字面量提供括号的场景，
    //    若也剥离就会出现缺括号（实测踩过第二次），故用白名单限定。
    const bracketWord = word === 't' || word === 'thread' || word === 'X' || word === 'mdc'
    const wrapped = bracketWord && literal.endsWith('[') && rest[conversion.lastIndex] === ']'
    if (wrapped) {
      literal = literal.slice(0, -1)
      conversion.lastIndex += 1
    }
    if (literal.length > 0) parts.push(spacify(escapeRegExp(literal)))
    if (word === 'd' || word === 'date') {
      parts.push(`(?<time>${dateToRegExp(arg)})`)
    } else if (word === 't' || word === 'thread') {
      parts.push(wrapped ? '\\[(?<thread>[^\\]]*)\\]' : '(?<thread>\\S+)')
    } else if (word === 'X' || word === 'mdc') {
      // 形如 %X{traceId:-        }：默认值（含空白）一律吞掉，避免空括号干扰
      parts.push(wrapped ? '\\[(?<traceId>[^\\]]*)\\]' : '(?<traceId>\\S*)')
    } else if (word === 'p' || word === 'level' || word === 'le') {
      parts.push(`(?<level>${LEVEL_PATTERN})`)
    } else if (word === 'c' || word === 'logger' || word === 'lo') {
      parts.push('(?<logger>\\S+)')
    } else if (word === 'm' || word === 'msg' || word === 'message') {
      parts.push('(?<message>[\\s\\S]*)')
      hasMessage = true
    }
    cursor = conversion.lastIndex
    match = conversion.exec(rest)
  }
  const tail = rest.slice(cursor)
  if (tail.length > 0) parts.push(spacify(escapeRegExp(tail)))
  if (!hasMessage) {
    throw new Error(`日志格式声明缺少消息体转换词（%msg/%m）：${declaration}`)
  }
  return { name, kind: 'pattern', declaration, regex: new RegExp(`^${parts.join('')}$`), fields: {} }
}

/**
 * 编译 JSON Lines 格式声明。
 *
 * @param name - 格式名。
 * @param fields - 字段映射；未声明的字段按别名表自动识别。
 * @returns 编译后的格式对象。
 */
export function compileJsonFormat(name: string, fields: JsonFieldMap = {}): CompiledFormat {
  return {
    name,
    kind: 'json',
    declaration: `JSON Lines（字段映射：${Object.keys(fields).length > 0 ? JSON.stringify(fields) : '自动别名'}}`,
    regex: /^\{.*\}$/,
    fields,
  }
}

/**
 * 按声明编译格式（自动分派 pattern / json 两种形态）。
 *
 * @param spec - 格式声明。
 * @returns 编译后的格式对象。
 */
export function compileFormat(spec: FormatSpec): CompiledFormat {
  return 'kind' in spec && spec.kind === 'json'
    ? compileJsonFormat(spec.name, spec.fields ?? {})
    : compileLogFormat(spec.name, (spec as { declaration: string }).declaration)
}

/** 按别名表取第一个命中的键值。 */
function pick(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key]
  }
  return undefined
}

/** 把任意值转成稳定的字符串（数字/布尔/对象统一处理）。 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === undefined || value === null) return ''
  return JSON.stringify(value)
}

/**
 * 解析一行 JSON Lines 日志。
 *
 * @param line - 原始行。
 * @param format - 已编译的 JSON 格式。
 * @param lineNo - 行号（证据锚点）。
 * @returns 解析结果；不是 JSON 对象或缺消息体时返回 null（计入漏网，由覆盖度告警）。
 */
function parseJsonLine(line: string, format: CompiledFormat, lineNo: number): ParsedRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const map = format.fields
  const message = stringify(pick(obj, map.message === undefined ? JSON_ALIASES.message : [map.message]))
  if (message === '') return null
  const rawLevel = pick(obj, map.level === undefined ? JSON_ALIASES.level : [map.level])
  const level = typeof rawLevel === 'number'
    ? (NUMERIC_LEVELS[rawLevel] ?? String(rawLevel))
    : stringify(rawLevel).toUpperCase()
  const rawTime = pick(obj, map.time === undefined ? JSON_ALIASES.time : [map.time])
  const time = typeof rawTime === 'number' ? new Date(rawTime).toISOString() : stringify(rawTime)
  const traceId = stringify(pick(obj, map.caseId === undefined ? JSON_ALIASES.caseId : [map.caseId]))
  const objectId = stringify(pick(obj, map.objectId === undefined ? JSON_ALIASES.objectId : [map.objectId]))
  const logger = stringify(pick(obj, map.logger === undefined ? JSON_ALIASES.logger : [map.logger]))
  return {
    line: lineNo,
    raw: line,
    time,
    level,
    logger,
    message,
    thread: '',
    traceId,
    objectId,
  }
}

/**
 * 按编译后的格式解析一行日志。
 *
 * @param line - 单行原始文本（不含换行符）。
 * @param format - 已编译的格式。
 * @param lineNo - 该行在源文件中的行号（1 基），作为证据锚点。
 * @returns 解析结果；格式不匹配时返回 `null`（由上层计入未解析，不抛异常）。
 */
export function parseLogLine(line: string, format: CompiledFormat, lineNo: number): ParsedRecord | null {
  if (format.kind === 'json') return parseJsonLine(line, format, lineNo)
  const matched = format.regex.exec(line)
  if (matched === null) return null
  const groups = matched.groups ?? {}
  return {
    line: lineNo,
    raw: line,
    time: (groups.time ?? '').trim(),
    level: (groups.level ?? '').trim().toUpperCase(),
    logger: (groups.logger ?? '').trim(),
    message: (groups.message ?? '').trim(),
    thread: (groups.thread ?? '').trim(),
    traceId: (groups.traceId ?? '').trim(),
    objectId: '',
  }
}

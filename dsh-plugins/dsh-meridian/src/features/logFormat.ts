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
}

/** 编译后的格式：正则 + 字段可见性。 */
export interface CompiledFormat {
  /** 格式名（用于报错与产物标注）。 */
  readonly name: string
  /** 原始格式声明文本（原样保留，供人核对与版本比对）。 */
  readonly declaration: string
  /** 编译所得正则，具名捕获组。 */
  readonly regex: RegExp
}

/** logback 日期格式 → 正则片段的映射（只覆盖工程上真实出现的几种）。 */
const DATE_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['yyyy-MM-dd HH:mm:ss.SSS', '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}'],
  ['yyyy-MM-dd HH:mm:ss', '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}'],
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
  return { name, declaration, regex: new RegExp(`^${parts.join('')}$`) }
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
  }
}

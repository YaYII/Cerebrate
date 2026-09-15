/**
 * Python（标准 logging）接入声明 —— 覆盖 `%(asctime)s %(levelname)s %(name)s: %(message)s` 默认格式。
 *
 * 本文件干什么：声明 Python logging 的默认行格式。
 * 本文件不干什么：不含解析逻辑；规则留空，因为 Python 应用的业务语义因项目而异，
 * 由使用方通过 `definition` 追加规则（或直接用 JSON Lines 输出）。
 *
 * 格式证据：2026-09-15 真实日志 `~/.hermes/logs/agent.log`（497 行，全部为默认格式）：
 *   `2026-07-01 15:56:38,511 INFO hermes_cli.plugins: Plugin 'browser-use' registered ...`
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { RulePack } from '../features/rulePack'

/** Python logging 默认格式的接入声明。 */
export const PYTHON_LOGGING_PACK: RulePack = {
  name: 'python-logging',
  formats: [
    {
      name: 'python-logging-default',
      // Python logging 的 asctime 默认带逗号毫秒，与 Java/PHP 的点号毫秒不同
      declaration: '%d{yyyy-MM-dd HH:mm:ss,SSS} %level %logger: %msg',
    },
    {
      // 同一项目常见的第二种配置：级别后多一段 [session_id]（实测 110/497 行属此变体）
      name: 'python-logging-with-session',
      // `%X{...}` 在本声明语言里表示「方括号包裹的关联字段」，会被抽成 caseId
      declaration: '%d{yyyy-MM-dd HH:mm:ss,SSS} %level [%X{session_id}] %logger: %msg',
    },
  ],
  rules: [
    {
      name: 'traceback-frame',
      phase: 'exception',
      pattern: '^(?<etype>\\w+(?:\\.\\w+)*): (?<emsg>[\\s\\S]*)$',
      label: '异常 {etype}',
      detail: '{emsg}',
      actor: 'logger',
    },
  ],
}

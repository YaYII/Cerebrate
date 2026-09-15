/**
 * 多语言接入回归测试 —— Node（JSON Lines）与 Python（标准 logging）两套生态。
 *
 * 语料取自 2026-09-15 机器上的真实日志：
 *   Node：`~/.dsh/profiles/web/hub.log`（单行 JSON）
 *   Python：`~/.hermes/logs/agent.log`（标准 logging，且**混用两种格式变体**）
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ingestLogText } from '../src/features/ingest'
import { compileFormat, parseLogLine } from '../src/features/logFormat'
import { NODE_JSON_PACK } from '../src/packs/nodeJsonLines'
import { PYTHON_LOGGING_PACK } from '../src/packs/pythonLogging'

/** 真实 Node JSON 行（原样抄自 hub.log）。 */
const NODE_LINE =
  '{"at":1788170577517,"level":"info","category":"system","event":"system.start","message":"Plugin Hub 已启动（profile=web）"}'

/** 真实 Node pino 数字级别（pino 默认 30=info）。 */
const NODE_PINO_NUMERIC = '{"level":40,"time":1788170577517,"msg":"request failed","trace_id":"t-1","app_no":"MS-1"}'

/** 真实 Python 行（默认格式）。 */
const PY_DEFAULT = "2026-07-01 15:56:38,511 INFO hermes_cli.plugins: Plugin 'browser-use' registered browser provider"

/** 真实 Python 行（第二种变体：级别后多一段 [session_id]）。 */
const PY_SESSION = '2026-07-01 16:33:44,037 INFO [20260701_163225_1b87fb] agent.conversation_loop: API call #1'

describe('Node/通用：JSON Lines 一份声明覆盖多生态', () => {
  it('解析单行 JSON，并按别名抽出时间/级别/消息/来源', () => {
    const format = compileFormat({ name: 'json-lines', kind: 'json' })
    const parsed = parseLogLine(NODE_LINE, format, 1)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.level, 'INFO')
    assert.equal(parsed?.logger, 'system')
    assert.ok(parsed?.message.includes('Plugin Hub'))
    assert.ok((parsed?.time ?? '').startsWith('2026-'))
  })

  it('支持 pino 数字级别（30/40 → INFO/WARN）并直接采纳 JSON 里的 caseId / objectId', () => {
    const result = ingestLogText(NODE_PINO_NUMERIC, { source: 'hub.log', pack: NODE_JSON_PACK })
    const event = result.events[0]
    assert.equal(event.level, 'WARN')
    assert.equal(event.caseId, 't-1')
    assert.equal(event.objectId, 'MS-1')
  })

  it('真实 Node 日志解析率 100%（本例 2 行）', () => {
    const result = ingestLogText([NODE_LINE, NODE_PINO_NUMERIC].join('\n'), { source: 'hub.log', pack: NODE_JSON_PACK })
    assert.equal(result.formatUsed, 'json-lines')
    assert.equal(result.coverage.recordLines, 2)
    assert.equal(result.coverage.orphanLines, 0)
    assert.equal(result.verdict, 'ok')
  })

  it('非 JSON 行计入漏网并触发显式失败（不静默当成"没问题"）', () => {
    const result = ingestLogText('这不是 JSON\n也不是日志\n', { source: 'x.log', pack: NODE_JSON_PACK })
    assert.equal(result.eventCount, 0)
    assert.equal(result.verdict, 'failed')
    assert.ok(result.warnings.some((item) => item.includes('不可作为')))
  })
})

describe('Python：标准 logging 的两种格式变体', () => {
  it('默认格式可解析（逗号毫秒是 Python 特有的写法）', () => {
    const format = compileFormat(PYTHON_LOGGING_PACK.formats[0])
    const parsed = parseLogLine(PY_DEFAULT, format, 1)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.level, 'INFO')
    assert.equal(parsed?.logger, 'hermes_cli.plugins')
    assert.ok(parsed?.time.includes(','))
  })

  it('带 session_id 的变体被解析，且 session 被抽成案例标识', () => {
    const result = ingestLogText(PY_SESSION, { source: 'agent.log', pack: PYTHON_LOGGING_PACK })
    const event = result.events[0]
    assert.equal(event.caseId, '20260701_163225_1b87fb')
    assert.equal(event.logger, 'agent.conversation_loop')
  })

  it('混格式文件逐行回退解析，并披露「混用了多种格式」', () => {
    const result = ingestLogText([PY_DEFAULT, PY_SESSION].join('\n'), { source: 'agent.log', pack: PYTHON_LOGGING_PACK })
    assert.equal(result.coverage.recordLines, 2)
    assert.equal(result.coverage.orphanLines, 0)
    assert.equal(result.verdict, 'ok')
    assert.ok(result.warnings.some((item) => item.includes('混用了多种日志格式')))
    // 两个案例：一个来自 session 变体，一个无链路标识
    assert.equal(result.caseCount, 2)
  })
})

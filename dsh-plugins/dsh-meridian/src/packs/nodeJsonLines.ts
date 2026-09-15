/**
 * Node/通用「结构化日志（JSON Lines）」接入声明 —— 一份声明覆盖多个生态。
 *
 * 本文件干什么：声明 JSON Lines 格式（字段映射留空 → 走自动别名识别）。
 * 本文件不干什么：不含解析逻辑。
 *
 * 覆盖范围（同一形态、不同库）：pino / bunyan（Node）、structlog（Python）、
 * zap / logrus（Go）、logstash-logback-encoder（Java）。
 *
 * 格式证据：2026-09-15 真实日志 `~/.dsh/profiles/web/hub.log`（143 行，全部为单行 JSON）：
 *   `{"at":1788170577517,"level":"info","category":"system","event":"system.start","message":"Plugin Hub 已启动"}`
 *
 * 字段别名（自动识别）：时间 time/at/timestamp/ts/@timestamp；级别 level/lvl/severity（含 pino 数字级别）；
 * 消息 message/msg/event/text；来源 logger/name/category/module/service；
 * 案例 trace_id/traceId/request_id；业务对象 app_no/order_no/biz_id。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { RulePack } from '../features/rulePack'

/** JSON Lines 接入声明。 */
export const NODE_JSON_PACK: RulePack = {
  name: 'json-lines',
  formats: [{ name: 'json-lines', kind: 'json' }],
  rules: [
    {
      name: 'lifecycle-event',
      phase: 'audit',
      pattern: '.*',
      label: '{message}',
      actor: 'logger',
    },
  ],
}

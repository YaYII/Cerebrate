/**
 * IHM2（房屋局）Laravel 接入声明 —— 该系统的日志格式与消息规则，全部以数据形式声明。
 *
 * 本文件干什么：声明 Laravel/Monolog 的日志格式，以及把真实日志消息映射为运行时事件的规则。
 * 本文件不干什么：不含解析逻辑（逻辑在 features/），不读写文件。
 *
 * 证据来源（全部来自真实产物，非推测）：
 * - 格式：`storage/logs/<实例ID>-laravel-<日期>.log` 实际行形如
 *   `[2026-09-15 10:24:59] local.INFO: API Request {"trace_id":"...","duration_ms":58.57}`；
 * - 规则文案：同上真实日志（含 Laravel Monolog 默认 LineFormatter：`[%datetime%] %channel%.%level_name%: %message% %context% %extra%`）；
 * - 业务活动字段：`維修資金申請新增/修改` 行由项目自身的业务埋点产出，
 *   含 `task_name`（中文业务活动名）、`point`（流程节点）、`app_no`（业务单据号）、`user_id`、`duration_ms`。
 *
 * 本接入的**独特价值**：这是两个实例中第一次同时拿到
 * 「技术案例（trace_id）＋ 业务案例（app_no）＋ 人（user_id）＋ 业务活动名（task_name）＋ 耗时」，
 * 即调研报告里所说的「活动本体 + 多案例视角」在真实系统里已经具备雏形。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { RulePack } from '../features/rulePack'

/** JSON 尾部允许的空白与空 context/extra 残渣。 */
const TAIL = '\\s*(?:\\[\\]\\s*)?(?:\\{\\}\\s*)?$'

/** IHM2 接入声明。 */
export const IHM2_PACK: RulePack = {
  name: 'ihm2-laravel',
  formats: [
    {
      name: 'ihm2-laravel',
      declaration: '[%datetime%] %channel%.%level_name%: %message% %context% %extra%',
    },
  ],
  rules: [
    {
      name: 'api-request',
      phase: 'request-out',
      pattern:
        '^API Request \\{"trace_id":"(?<trace>[^"]+)","method":"(?<method>[^"]+)","url":"(?<url>[^"]+)",' +
        '"status":(?<status>\\d+),"duration_ms":(?<cost>[\\d.]+),"user_id":(?<user>[^,]*),"ip":"(?<ip>[^"]+)"\\}' +
        TAIL,
      label: 'API {method} {url} → {status}',
      detail: 'method={method}\nurl={url}\nstatus={status}\nip={ip}',
      durationField: 'cost',
      caseIdField: 'trace',
      actor: 'logger',
    },
    {
      name: 'mf-application-activity',
      phase: 'step',
      pattern:
        '^(?<activity>維修資金申請(?:新增|修改)) \\{"trace_id":"(?<trace>[^"]+)","action":"(?<action>[^"]+)",' +
        '"point":"(?<point>[^"]+)","task_name":"(?<task>[^"]+)","fund_id":(?<fund>\\d+),' +
        '"app_no":"(?<obj>[^"]+)","user_id":(?<user>\\d+),"username":"(?<uname>[^"]+)",' +
        '"duration_ms":(?<cost>[\\d.]+)\\}' +
        TAIL,
      label: '{task}',
      detail: '节点={point} 单据={obj} 操作人={uname} action={action}',
      durationField: 'cost',
      caseIdField: 'trace',
      objectIdField: 'obj',
      actor: 'logger',
    },
    {
      name: 'slow-query',
      phase: 'slow',
      pattern: '^Slow Query Detected (?<ctx>\\{.*"threshold":(?<threshold>[\\d.]+).*\\})' + TAIL,
      label: '慢查询（阈值 {threshold}ms）',
      detail: 'threshold={threshold}ms',
      actor: 'logger',
    },
    {
      name: 'external-call-request',
      phase: 'call',
      pattern: '^(?<svc>\\w+Service)\\.(?<m>\\w+) request: (?<ctx>\\{.*\\})' + TAIL,
      label: '{svc}.{m} 请求',
      detail: '{ctx}',
      actor: 'logger',
      stackPush: true,
    },
    {
      name: 'external-call-response',
      phase: 'return',
      pattern: '^(?<svc>\\w+Service)\\.(?<m>\\w+) response: (?<ctx>\\{.*\\})' + TAIL,
      label: '{svc}.{m} 响应',
      detail: '{ctx}',
      actor: 'logger',
      stackPop: true,
    },
    {
      name: 'controller-invocation',
      phase: 'call',
      pattern: '^(?<ctrl>\\w+Controller)@(?<action>\\w+)(?: (?<rest>.*))?' + TAIL,
      label: '{ctrl}@{action}',
      detail: '{rest}',
      actor: 'logger',
      stackPush: true,
    },
  ],
}

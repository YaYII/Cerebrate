/**
 * IHM2（房屋局）维修资金申请流程的意图声明 —— 以数据形式声明「业务上应该怎么走」。
 *
 * 本文件干什么：声明按**单据视角**（业务对象）判定的意图。
 * 本文件不干什么：不含判定逻辑（逻辑在 features/ruler），不读写文件。
 *
 * 声明依据：2026-09-15 真实日志（`storage/logs/*-laravel-*.log`）中
 * `維修資金申請新增/修改` 业务埋点实际给出的 `task_name` / `point` / `app_no` 语义。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { Intent } from '../features/ruler'

/** IHM2 意图包（按单据视角判定）。 */
export const IHM2_INTENTS: Intent[] = [
  {
    name: '维修资金申请-新增后应有后续操作',
    appliesWhen: { labelContains: '新增維修資金申請' },
    expect: [
      { name: '新增申请', match: { labelContains: '新增維修資金申請' }, mustSucceed: true },
      { name: '后续修改', match: { labelContains: '修改維修資金申請' } },
    ],
    expectEnd: { labelContains: '修改維修資金申請' },
  },
  {
    name: '维修资金申请-创建步骤成功',
    appliesWhen: { labelContains: '維修資金申請' },
    expect: [{ name: '新增申请', match: { labelContains: '新增維修資金申請' }, mustSucceed: true }],
    expectEnd: { labelContains: '新增維修資金申請' },
    // 本意图只关心「创建这一步发生」；创建之后的修改属合法后续，须显式声明为允许，
    // 否则会被判为「额外路径」——这是**声明不全**而非标尺缺陷（实测踩过，5 条误报）。
    allow: [{ labelContains: '修改維修資金申請' }],
  },
]

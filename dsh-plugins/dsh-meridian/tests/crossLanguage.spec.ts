/**
 * 跨语言与脱敏回归测试 —— 锁住「同一内核服务 Java 与 PHP 两套生态」以及「凭据不外泄」。
 *
 * 语料取自 IHM2（Laravel）2026-09-15 真实运行日志原文。
 * 本文件不干什么：不访问网络、不读被观测项目（语料内联）。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ingestLogText } from '../src/features/ingest'
import { compileLogFormat, parseLogLine, translateMonolog } from '../src/features/logFormat'
import { isSecretKey, redactJsonText, redactLine, redactText } from '../src/features/redact'
import { IHM2_PACK } from '../src/packs/ihm2Laravel'

/** 真实 Laravel 日志（原样抄自 storage/logs，JWT 已按真实形态构造但值已替换）。 */
const API_LINE =
  '[2026-09-15 10:24:59] local.INFO: API Request {"trace_id":"42b809c8-23af-4838-88ea-bb85dd043689","method":"POST","url":"http://localhost/api/simulation/NP/GetStaffInfoByUserID","status":200,"duration_ms":58.57,"user_id":null,"ip":"127.0.0.1"}'
const BIZ_LINE =
  '[2026-09-15 10:26:17] local.DEBUG: 維修資金申請新增 {"trace_id":"a29f9efd-5797-426c-a7f2-e350eb6a9459","action":"create","point":"create_app","task_name":"新增維修資金申請","fund_id":94,"app_no":"MS-CHK-1789439176","user_id":1,"username":"DAPET1","duration_ms":32.2}'
const BIZ_UPDATE =
  '[2026-09-15 10:26:30] local.DEBUG: 維修資金申請修改 {"trace_id":"a29f9efd-5797-426c-a7f2-e350eb6a9459","action":"update","point":"update_app","task_name":"修改維修資金申請","fund_id":94,"app_no":"MS-CHK-1789439176","user_id":1,"username":"DAPET1","duration_ms":5.5}'
const TOKEN_LINE =
  '[2026-09-15 10:24:59] local.INFO: LoginController@getToken Login as {"keycloakUser":{"token":"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpM"}}'
const SLOW_LINE =
  '[2026-09-15 10:25:00] local.WARNING: Slow Query Detected {"sql":"insert into TOKENS values (?)","bindings":["0addf100da255aff22e33220423911fd38a4deb1c0d1"],"time_ms":1789439099.9,"threshold":1000,"url":"http://x/login"}'

describe('跨语言：Monolog（PHP/Laravel）格式声明', () => {
  it('Monolog 写法被翻译为通用写法，且不丢字面方括号', () => {
    assert.equal(
      translateMonolog('[%datetime%] %channel%.%level_name%: %message% %context% %extra%'),
      '[%d{yyyy-MM-dd HH:mm:ss}] %logger.%level: %msg',
    )
    const format = compileLogFormat('ihm2', '[%datetime%] %channel%.%level_name%: %message% %context% %extra%')
    const parsed = parseLogLine(API_LINE, format, 1)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.level, 'INFO')
    assert.equal(parsed?.logger, 'local')
    assert.ok(parsed?.message.startsWith('API Request'))
  })

  it('真实 Laravel 日志解析率 100%（含 context/extra 残渣）', () => {
    const text = [API_LINE, BIZ_LINE, BIZ_UPDATE, TOKEN_LINE, SLOW_LINE].join('\n')
    const result = ingestLogText(text, { source: 'ihm2.log', pack: IHM2_PACK })
    assert.equal(result.formatUsed, 'ihm2-laravel')
    assert.equal(result.coverage.recordLines, 5)
    assert.equal(result.coverage.orphanLines, 0)
    assert.equal(result.verdict, 'ok')
  })
})

describe('案例视角：技术案例与业务对象必须分开建模', () => {
  it('trace_id 来自消息体（PHP 生态）也能作为技术案例', () => {
    const result = ingestLogText(API_LINE, { source: 'ihm2.log', pack: IHM2_PACK })
    const event = result.events[0]
    assert.equal(event.caseId, '42b809c8-23af-4838-88ea-bb85dd043689')
    assert.equal(event.phase, 'request-out')
    assert.equal(event.durationMs, 58.57) // 保留源精度，不截断
  })

  it('单据号 app_no 进入业务对象维度，且与 trace_id 相互独立', () => {
    const text = [BIZ_LINE, BIZ_UPDATE].join('\n')
    const result = ingestLogText(text, { source: 'ihm2.log', pack: IHM2_PACK })
    // 技术案例只有一个（同一 trace），业务对象也只有一个（同一单据）
    assert.equal(result.cases.length, 1)
    assert.equal(result.objectCases.length, 1)
    assert.equal(result.objectCases[0].caseId, 'MS-CHK-1789439176')
    assert.equal(result.objectCases[0].events.length, 2)
    // 业务活动名是中文语义，而不是技术方法名
    assert.deepEqual(
      result.objectCases[0].events.map((event) => event.label),
      ['新增維修資金申請', '修改維修資金申請'],
    )
    // 耗时被累加，可归因
    assert.equal(result.objectCases[0].totalMs, 37.7) // 32.2 + 5.5
  })

  it('多对多：一次 trace 可跨多张单据，一张单据可跨多次 trace', () => {
    const text = [BIZ_LINE, BIZ_UPDATE.replace('a29f9efd-5797-426c-a7f2-e350eb6a9459', 'ffffffff-0000-0000-0000-000000000000')].join('\n')
    const result = ingestLogText(text, { source: 'ihm2.log', pack: IHM2_PACK })
    assert.equal(result.cases.length, 2, '两次 trace')
    assert.equal(result.objectCases.length, 1, '同一张单据')
  })
})

describe('脱敏：凭据绝不进入事实模型', () => {
  it('JWT 与长随机串被掩码', () => {
    assert.ok(!redactText('token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpM').includes('eyJ'))
    assert.ok(!redactText('id=0addf100da255aff22e33220423911fd38a4deb1c0d1').includes('0addf100'))
  })

  it('敏感键名（含中英文）被识别', () => {
    for (const key of ['access_token', 'refreshToken', 'password', 'authorization', '密碼', '簽名']) {
      assert.equal(isSecretKey(key), true, key)
    }
    assert.equal(isSecretKey('app_no'), false)
  })

  it('JSON 键级脱敏：敏感键整值掩码，非敏感键保留', () => {
    const masked = redactJsonText('{"app_no":"MS-1","token":"secret-value","nested":{"pwd":"x"}}')
    const parsed = JSON.parse(masked) as Record<string, unknown>
    assert.equal(parsed.app_no, 'MS-1')
    assert.equal(parsed.token, '***')
    assert.equal((parsed.nested as Record<string, unknown>).pwd, '***')
  })

  it('真实登录日志经摄取后无凭据残留', () => {
    const result = ingestLogText(TOKEN_LINE, { source: 'ihm2.log', pack: IHM2_PACK })
    const blob = JSON.stringify(result)
    assert.ok(!blob.includes('eyJ'), '证据与细节中不得出现 JWT')
  })

  it('fail-closed：JSON 解析失败时退化为全文本脱敏，而不是原样透出', () => {
    const broken = '{"token":"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpM", broken'
    assert.ok(!redactJsonText(broken).includes('eyJ'))
    assert.ok(!redactLine(TOKEN_LINE).includes('eyJ'))
  })
})

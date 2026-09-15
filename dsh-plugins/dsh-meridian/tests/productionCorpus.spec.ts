/**
 * 真实生产语料回归测试 —— 锁住三个「只有生产数据才会暴露」的行为。
 *
 * 语料：2026-09-14/15 DSEDT 生产实例真实日志（原样节选）。
 * 本文件不干什么：不访问容器、不读生产文件（语料已内联固化）。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ingestLogText } from '../src/features/ingest'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'

/** 真实生产日志头：traceId 是「时间戳-短随机」，与测试语料的 UUID 完全不同。 */
const TID = '0914151149-66abcfee'
const FULL_ORDER = 'ORD-9006aa6e5c0f4c169ae799e001e24339'

/** 真实行：含完整单据号。 */
const LINE_FULL = `2026-09-14 15:11:49.530 [http-nio-8000-exec-340] [${TID}] INFO  c.d.v.s.b.i.VerificationServiceImpl - 核验完成: orderNo=${FULL_ORDER}, refId=ACC-134, verified=true, bindResult=SUCCESS, 核验耗时=89ms, 状态持有耗时=7ms`

/** 真实行：**应用自身脱敏**后截断的单据号（同一张单据）。 */
const LINE_MASKED = `2026-09-14 15:11:49.407 [http-nio-8000-exec-340] [${TID}] INFO  c.d.v.s.f.i.VerificationCompletionServiceImpl - → …complete | ctx=VerificationLog{refId='ACC-134', orderNo=ORD-9006aa…（已脱敏）}`

/** 真实行：主档收敛（也带完整单据号）。 */
const LINE_CONVERGE = `2026-09-14 15:11:49.547 [http-nio-8000-exec-340] [${TID}] INFO  c.d.v.s.b.i.VerificationServiceImpl - 主档收敛为 SUCCESS(定向UPDATE): orderNo=${FULL_ORDER}`

/** 真实行：complete 分段（生产新增的格式族）。 */
const LINE_COMPLETE = `2026-09-14 15:11:49.510 [http-nio-8000-exec-340] [${TID}] INFO  c.d.v.s.f.i.VerificationCompletionServiceImpl - complete分段(慢): 绑定判定=0ms 签名(私钥取用+RSA)=40ms 结果缓存=63ms 合计=103ms path=WHITELIST`

/** 真实行：verifyCode 逐步（另一种分段族）。 */
const LINE_STEP = `2026-09-14 15:11:49.389 [http-nio-8000-exec-340] [${TID}] INFO  c.d.v.s.f.i.DynamicQrCodeServiceImpl - verifyCode逐步: ①查碼(Redis命中)=5ms qr=B8AC022E…`

describe('真实生产：格式兼容（traceId 不是 UUID）', () => {
  it('时间戳-短随机格式的 traceId 被正确抽取为技术案例', () => {
    const result = ingestLogText(LINE_FULL, { source: 'prod.log', pack: DSEDT_PACK })
    assert.equal(result.formatUsed, 'dsedt-prod')
    assert.equal(result.verdict, 'ok')
    assert.equal(result.events[0].caseId, TID)
  })
})

describe('真实生产：应用自身脱敏切断身份时的消歧', () => {
  it('完整值与掩码值归并为同一个业务对象（前缀唯一匹配）', () => {
    const text = [LINE_FULL, LINE_MASKED, LINE_CONVERGE].join('\n')
    const result = ingestLogText(text, { source: 'prod.log', pack: DSEDT_PACK })
    assert.equal(result.objectCases.length, 1, '同一张单据不得被拆成两个对象')
    assert.equal(result.objectCases[0].caseId, FULL_ORDER)
    assert.ok(result.warnings.some((item) => item.includes('掩码标记')), '掩码必须被披露')
    assert.ok(result.warnings.some((item) => item.includes('1 条按「前缀唯一匹配」归并')))
  })

  it('前缀不唯一时保持原样，不猜测', () => {
    const otherOrder = `ORD-9006aa` + 'ffffffffffffffffffffffffffff'
    const ambiguous = LINE_MASKED
    const text = [
      ambiguous,
      LINE_FULL,
      LINE_FULL.replace(FULL_ORDER, otherOrder),
    ].join('\n')
    const result = ingestLogText(text, { source: 'prod.log', pack: DSEDT_PACK })
    const warn = result.warnings.find((item) => item.includes('掩码标记')) ?? ''
    assert.ok(warn.includes('1 条无法唯一确定'), `应报告无法唯一确定，实际：${warn}`)
  })
})

describe('真实生产：新增分段格式族', () => {
  it('complete分段 的段与合计都被抽出，「合计」不计入分段', () => {
    const result = ingestLogText(LINE_COMPLETE, { source: 'prod.log', pack: DSEDT_PACK })
    const event = result.events[0]
    assert.equal(event.phase, 'slow')
    assert.equal(event.durationMs, 103, '总耗时取合计')
    assert.deepEqual(
      event.segments.map((segment) => segment.name),
      ['绑定判定', '签名(私钥取用+RSA)', '结果缓存'],
      '「合计」应被 ignore 名单排除',
    )
  })

  it('verifyCode逐步 的段名含序号与括号也能抽出', () => {
    const result = ingestLogText(LINE_STEP, { source: 'prod.log', pack: DSEDT_PACK })
    const segments = result.events[0].segments
    assert.equal(segments.length, 1)
    assert.ok(segments[0].name.includes('查碼'))
    assert.equal(segments[0].ms, 5)
  })
})

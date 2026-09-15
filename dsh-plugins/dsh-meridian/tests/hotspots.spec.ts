/**
 * 热点归因回归测试 —— 锁住「时间花在哪 / 慢在哪一段」两条口径的正确性。
 *
 * 语料取自真实日志：DSEDT 的分段耗时行、IHM2 的 API Request 行。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { computeHotspots } from '../src/features/hotspots'
import { ingestLogText } from '../src/features/ingest'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'
import { IHM2_PACK } from '../src/packs/ihm2Laravel'

/** 真实 DSEDT 分段耗时行（原样抄自日志）。 */
const DSEDT_STAGE =
  '10:27:27.522 [Test worker] INFO com.dsedt.verification.service.business.impl.VerificationServiceImpl -- confirm分段(慢): 抢占+载入=1ms 核验(含白名单+码+签名)=6ms 落库(主档+缓冲)=24ms 响应+缓存+审计=2ms 终态发布=0ms 合计=33ms'

/** 真实 IHM2 API 行（同一端点的两次调用，用于验证归并）。 */
const IHM2_A =
  '[2026-09-15 10:24:59] local.INFO: API Request {"trace_id":"t1","method":"POST","url":"http://x/api/a","status":200,"duration_ms":58.57,"user_id":null,"ip":"127.0.0.1"}'
const IHM2_B =
  '[2026-09-15 10:25:01] local.INFO: API Request {"trace_id":"t2","method":"POST","url":"http://x/api/a","status":200,"duration_ms":101.43,"user_id":1,"ip":"127.0.0.1"}'

describe('热点归因：时间花在哪', () => {
  it('同一端点的多次调用被归并（归并键抹掉数值与单号）', () => {
    const result = ingestLogText([IHM2_A, IHM2_B].join('\n'), { source: 'x.log', pack: IHM2_PACK })
    const report = computeHotspots(result.events)
    assert.equal(report.timedEvents, 2)
    // 耗时保留源精度（parseFloat），不做截断：58.57 + 101.43 = 160
    assert.equal(report.totalMs, 160)
    assert.equal(report.byTotal.length, 1, '两次调用应归并为同一个热点')
    assert.equal(report.byTotal[0].count, 2)
    assert.equal(report.byTotal[0].maxMs, 101.43)
    assert.equal(report.byTotal[0].p50Ms, 58.57)
  })

  it('分段耗时被抽出并单独成榜（回答「慢在哪一段」）', () => {
    const result = ingestLogText(DSEDT_STAGE, { source: 'x.log', pack: DSEDT_PACK })
    const event = result.events[0]
    assert.equal(event.phase, 'slow')
    assert.equal(event.durationMs, 33, '总耗时取「合计」')
    // 「合计」已按 ignore 名单排除，不混入分段榜
    assert.deepEqual(
      event.segments.map((segment) => segment.name),
      ['抢占+载入', '核验(含白名单+码+签名)', '落库(主档+缓冲)', '响应+缓存+审计', '终态发布'],
    )
    const report = computeHotspots(result.events)
    const hot = report.byTotal.find((item) => item.key.includes('落库'))
    assert.notEqual(hot, undefined, '落库段应出现在热点榜')
    assert.equal(hot?.totalMs, 24)
    assert.equal(hot?.evidence[0].line, 1, '热点必须带证据行号')
  })
})

describe('口径正确性（避免重复计算与假性结论）', () => {
  it('事件总耗时与分段耗时分别累加，不重复计算', () => {
    const result = ingestLogText(DSEDT_STAGE, { source: 'x.log', pack: DSEDT_PACK })
    const report = computeHotspots(result.events)
    assert.equal(report.totalMs, 33, '事件合计不含分段')
    assert.equal(report.segmentTotalMs, 33, '分段合计 = 1+6+24+2+0')
    assert.notEqual(report.totalMs, 66, '两者不得混加')
  })

  it('无任何耗时事实时给出「不能据此断定没性能问题」的口径提示', () => {
    const result = ingestLogText('10:27:27.500 [T] INFO c.Foo -- 普通日志一行', { source: 'x.log', pack: DSEDT_PACK })
    const report = computeHotspots(result.events)
    assert.equal(report.timedEvents, 0)
    assert.ok(report.note.includes('不能据此得出'))
  })

  it('p95 采用最近秩法且不越界', () => {
    const events = [10, 20, 30, 40, 50].map((ms, index) => ({
      id: `e${index}`, seq: index + 1, ts: '', level: 'INFO', logger: 'L', thread: '',
      caseId: '', objectId: '', objectIdMasked: false, phase: 'step' as const, from: null, to: null,
      label: '同一活动', detail: '', durationMs: ms, ok: null, segments: [],
      evidence: { source: 'x.log', line: index + 1, lineCount: 1, snippet: 'x' },
    }))
    const report = computeHotspots(events)
    assert.equal(report.byTotal[0].p50Ms, 30)
    assert.equal(report.byTotal[0].p95Ms, 50)
    assert.equal(report.byTotal[0].maxMs, 50)
  })
})

/**
 * 真实流量回归（2026-09-15，DSEDT app-dev 容器实测）。
 *
 * 本文件的每一行日志都是**逐字复制**自一次真实端到端核验流程产生的日志切片，
 * 不是构造的样例。动因：既有 fixture 缺了「同一个单据号的结构污染形态」，
 * 于是三个真实缺陷全部漏网，直到跑真实流量才暴露——
 *
 * | 缺陷 | 真实证据 | 后果 |
 * | --- | --- | --- |
 * | 对象号吞掉 `}` / `&timestamp=` | L16 / L57 | 一张单据被拆成 4 个业务对象 |
 * | 污染值进入掩码消歧候选集 | 同上 | 本该唯一匹配的掩码件被判「歧义」（3 候选 → 归并失败） |
 * | 状态码被归一化为 `<n>` | L14 | `状态=200` 与 `状态=500` 同串，接口退化判 `identical` |
 *
 * @module tests/liveTraffic
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildFingerprint, compareFingerprints, normalizeLabel } from '../src/features/fingerprint'
import { computeHotspots } from '../src/features/hotspots'
import { ingestLogText } from '../src/features/ingest'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'

/** 真实单据号（本次端到端流程产生的 orderNo）。 */
const ORDER = 'ORD-22bd376888664b439b9211afce077a5d'

/** 真实行 L16：值以 JSON 右花括号收尾。 */
const L_BRACE = `2026-09-15 14:41:18.286 [http-nio-8000-exec-9] [0915144118-92936f1a] INFO  c.d.v.controller.H5Controller - → H5Controller.orderDetail | body={orderNo=${ORDER}}`

/** 真实行 L57：值处在签名原文的查询串里，后随 `&timestamp=`。 */
const L_SIGNED = `2026-09-15 14:41:18.522 [http-nio-8000-exec-2] [0915144118-2f398912] INFO  c.d.v.filter.step.SignatureStep - 签名原文: clientType=H5&merchantId=mpay&nonce=10d59294-53b8-4596-b1b8-53f339c70b00&orderNo=${ORDER}&timestamp=1789454478504`

/** 真实行 L43：应用自身把单据号截断脱敏（同一张单据）。 */
const L_MASKED = '2026-09-15 14:41:18.408 [http-nio-8000-exec-1] [0915144118-2e27a53b] INFO  c.d.v.s.f.i.VerificationCompletionServiceImpl - → VerificationCompletionServiceImpl.complete | ctx=VerificationLog{refId=E2E-1789454477943-8cf3dd, userId=46f254b4caede76d32971e65948a96ba, activityCode=ACT-EC7C6F95, orderNo=ORD-22bd37…（已脱敏）, merchantId=mpay, channel=IMMIGRATION, requestIp=172.28.0.1, userAgent='

/** 真实行 L14：请求正常结束。 */
const L_OUT_200 = '2026-09-15 14:41:18.279 [http-nio-8000-exec-8] [0915144117-7a4ecc33] INFO  c.d.verification.filter.TraceFilter - ← 请求结束 POST /api/h5/entry 状态=200 耗时=314ms'

/** 同一次并发核验里真实出现的「处理中」（7 次 202 / 10 次 200）。 */
const L_OUT_202 = '2026-09-15 14:41:18.279 [http-nio-8000-exec-8] [0915144117-7a4ecc33] INFO  c.d.verification.filter.TraceFilter - ← 请求结束 POST /api/h5/confirm-verify 状态=202 耗时=126ms'

/** 退化场景（同一接口返回 500），用于验证「失败不再隐形」。 */
const L_OUT_500 = '2026-09-15 14:41:18.279 [http-nio-8000-exec-8] [0915144117-7a4ecc33] INFO  c.d.verification.filter.TraceFilter - ← 请求结束 POST /api/h5/entry 状态=500 耗时=314ms'

/** 真实行 L11：签名分段（RSA 是真实热点）。 */
const L_SIGN_STAGE = '2026-09-15 14:41:18.276 [http-nio-8000-exec-8] [0915144117-7a4ecc33] INFO  c.d.v.s.f.impl.SignatureServiceImpl - signForMerchant分段(慢): 取私钥=4ms 解析=0ms RSA=28ms merchant=mpay pemLen=1703'

describe('真实流量：业务对象标识的边界（一张单据不得被拆开）', () => {
  it('花括号 / 签名查询串 / 掩码截断三种形态归为同一个业务对象', () => {
    const result = ingestLogText([L_BRACE, L_SIGNED, L_MASKED].join('\n'), { source: 'live.log', pack: DSEDT_PACK })

    assert.equal(result.verdict, 'ok', '真实行必须 100% 解析')
    assert.deepEqual(
      result.objectCases.map((item) => item.caseId),
      [ORDER],
      '三种写法是同一张单据；出现 `ORD-…}` / `ORD-…&timestamp=…` / 裸前缀都是缺陷',
    )
  })

  it('掩码件按前缀唯一匹配归并，不再因污染值而误判歧义', () => {
    const result = ingestLogText([L_BRACE, L_SIGNED, L_MASKED].join('\n'), { source: 'live.log', pack: DSEDT_PACK })
    const warn = result.warnings.find((item) => item.includes('掩码标记')) ?? ''

    assert.ok(warn.includes('1 条按「前缀唯一匹配」归并'), `应归并成功，实际：${warn}`)
    assert.ok(warn.includes('0 条无法唯一确定'), `不应判为歧义，实际：${warn}`)
  })

  it('签名原文行本身仍被完整解析（边界收窄不得伤及该行）', () => {
    const result = ingestLogText(L_SIGNED, { source: 'live.log', pack: DSEDT_PACK })
    assert.equal(result.coverage.orphanLines, 0)
    assert.equal(result.events[0].objectId, ORDER)
  })
})

describe('真实流量：接口成败必须可见（这是标尺的核心刻度）', () => {
  it('状态码是分类值，不得被归一化抹平', () => {
    assert.notEqual(normalizeLabel('HTTP 200'), normalizeLabel('HTTP 500'), '成功与失败不得同串')
    assert.notEqual(normalizeLabel('HTTP 200'), normalizeLabel('HTTP 202'), '成功与「处理中」不得同串')
  })

  it('热点归因按状态码分组，200 与 202 不合并', () => {
    const text = [L_OUT_200, L_OUT_202].join('\n')
    const report = computeHotspots(ingestLogText(text, { source: 'live.log', pack: DSEDT_PACK }).events)
    const keys = report.byTotal.map((item) => item.key)

    assert.ok(keys.includes('HTTP 200'), `应含 HTTP 200，实际：${keys.join(' / ')}`)
    assert.ok(keys.includes('HTTP 202'), `应含 HTTP 202，实际：${keys.join(' / ')}`)
  })

  it('接口从 200 退化为 500 判为 structure-changed，而不是 identical', () => {
    const before = ingestLogText(L_OUT_200, { source: 'live.log', pack: DSEDT_PACK })
    const after = ingestLogText(L_OUT_500, { source: 'live.log', pack: DSEDT_PACK })
    const delta = compareFingerprints(buildFingerprint(before.events), buildFingerprint(after.events))

    assert.equal(delta.kind, 'structure-changed', '接口退化属于行为路径断裂（高置信），不得被判为「没变」')
  })

  it('状态码判定为区间：2xx/3xx 成功，4xx/5xx 失败', () => {
    const okOf = (line: string): boolean | null =>
      ingestLogText(line, { source: 'live.log', pack: DSEDT_PACK }).events[0].ok

    assert.equal(okOf(L_OUT_200), true)
    assert.equal(okOf(L_OUT_202), true)
    assert.equal(okOf(L_OUT_500), false)
  })
})

describe('真实流量：分段证据不得回归', () => {
  it('signForMerchant 分段完整抽出（RSA 是真实热点）', () => {
    const result = ingestLogText(L_SIGN_STAGE, { source: 'live.log', pack: DSEDT_PACK })
    const event = result.events[0]

    assert.equal(event.phase, 'slow')
    assert.deepEqual(
      event.segments.map((segment) => `${segment.name}=${segment.ms}`),
      ['取私钥=4', '解析=0', 'RSA=28'],
      '分段是第二战场定位「慢在哪一段」的直接证据，不得丢段',
    )
    // `pemLen=1703` 是长度不是耗时（无 ms 单位），**不应**被当成分段混进耗时排行
    assert.ok(
      !event.segments.some((segment) => segment.name === 'pemLen'),
      '非耗时键值不得混入分段',
    )
  })
})

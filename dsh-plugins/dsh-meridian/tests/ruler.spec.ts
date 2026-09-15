/**
 * 标尺回归测试 —— 锁住「指纹能区分改名与真变化」与「判定能抓漏做、且不误报」两条能力。
 *
 * 语料取自 2026-09-15 真实测试运行（DSEDT 核验确认流程）的真实日志行。
 * 本文件不干什么：不访问网络、不读被观测项目。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { buildFingerprint, compareFingerprints, normalizeLabel } from '../src/features/fingerprint'
import { ingestLogText } from '../src/features/ingest'
import { judgeCase, type Intent } from '../src/features/ruler'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'

/** 真实日志（核验确认流程节选，原样抄自 system-out）。 */
const REAL = [
  '10:27:27.496 [Test worker] INFO com.dsedt.verification.service.business.impl.VerificationServiceImpl -- 核验完成: orderNo=ORD-CONFIRM001, refId=ref-001, verified=true, bindResult=SUCCESS, 核验耗时=5ms, 状态持有耗时=7ms',
  '10:27:27.503 [Test worker] INFO com.dsedt.verification.service.business.impl.VerificationServiceImpl -- 主档收敛为 SUCCESS(定向UPDATE): orderNo=ORD-CONFIRM001',
  '10:27:27.505 [Test worker] ERROR com.dsedt.verification.service.business.impl.VerificationServiceImpl -- ⚠️ 异步落库入队失败(降级同步落库): orderNo=ORD-CONFIRM001',
].join('\n')

/** 同一流程的另一次运行：只有耗时与单号不同（应判为「无变化」）。 */
const REAL_RERUN = REAL.replace('核验耗时=5ms', '核验耗时=9ms').replace('状态持有耗时=7ms', '状态持有耗时=3ms')

/** 同一流程但少了一步（应判为结构变化）。 */
const REAL_MISSING_STEP = REAL.split('\n')
  .filter((line) => !line.includes('主档收敛'))
  .join('\n')

const INTENT: Intent = {
  name: '核验成功-主档收敛',
  appliesWhen: { labelContains: 'verified=true' },
  expect: [
    { name: '核验完成(成功)', match: { labelContains: 'verified=true' }, mustSucceed: true },
    { name: '主档落库', match: { labelContains: '主档' } },
  ],
  expectEnd: { labelContains: '主档' },
  allow: [{ labelContains: '异步落库入队失败' }],
}

/** 便捷：摄取并取第一个案例的事实。 */
function factsOf(text: string) {
  const result = ingestLogText(text, { source: 'case.log', pack: DSEDT_PACK })
  return { result, facts: result.cases[0] }
}

describe('行为指纹：区分「改名」与「真变化」', () => {
  it('标签归一化抹掉数值与键值，只留文案形状', () => {
    const normalized = normalizeLabel('核验完成: orderNo=ORD-CONFIRM001, 核验耗时=5ms')
    assert.ok(!normalized.includes('ORD-CONFIRM001'))
    assert.ok(!normalized.includes('5ms'))
    assert.ok(normalized.includes('核验完成'))
  })

  it('仅数值变化（同代码两次运行）判为 identical', () => {
    const a = factsOf(REAL).facts
    const b = factsOf(REAL_RERUN).facts
    const delta = compareFingerprints(buildFingerprint(a.events), buildFingerprint(b.events))
    assert.equal(delta.kind, 'identical')
  })

  it('删掉一步判为 length-changed 并给出首个分歧位置与双向证据', () => {
    const a = factsOf(REAL).facts
    const b = factsOf(REAL_MISSING_STEP).facts
    const delta = compareFingerprints(buildFingerprint(a.events), buildFingerprint(b.events))
    assert.equal(delta.kind, 'length-changed')
    assert.equal(delta.firstDivergence, 1)
    assert.ok(delta.baseSample?.label.includes('主档'))
  })

  it('纯改名（结构不变）判为 relabeled，而不是结构变化', () => {
    const a = factsOf(REAL).facts
    const renamed = REAL.replace('主档收敛为 SUCCESS(定向UPDATE)', '主档写入成功(定向更新)')
    const b = factsOf(renamed).facts
    const delta = compareFingerprints(buildFingerprint(a.events), buildFingerprint(b.events))
    assert.equal(delta.kind, 'relabeled')
    assert.equal(delta.firstDivergence, 1)
  })
})

describe('标尺判定：抓漏做、且不误报', () => {
  it('满足期望时判 pass', () => {
    const { result, facts } = factsOf(REAL)
    const verdict = judgeCase(INTENT, facts, result.verdict)
    assert.equal(verdict.status, 'pass')
    assert.deepEqual(verdict.matched, ['核验完成(成功)', '主档落库'])
    assert.equal(verdict.findings.length, 0)
  })

  it('漏做环节判 failed，并同时报出「漏做」与「未达终态」两类偏离', () => {
    const { result, facts } = factsOf(REAL_MISSING_STEP)
    const verdict = judgeCase(INTENT, facts, result.verdict)
    assert.equal(verdict.status, 'failed')
    const kinds = verdict.findings.map((item) => item.kind)
    assert.ok(kinds.includes('move-on-model'))
    assert.ok(kinds.includes('stuck'))
    assert.deepEqual(verdict.missing, ['主档落库'])
    // 证据必须可回跳
    const stuck = verdict.findings.find((item) => item.kind === 'stuck')
    assert.ok((stuck?.evidence.length ?? 0) > 0)
    assert.ok((stuck?.evidence[0].line ?? 0) > 0)
  })

  it('事实不可信时拒绝判定（inconclusive），不给「通过」', () => {
    const { facts } = factsOf(REAL)
    const verdict = judgeCase(INTENT, facts, 'failed')
    assert.equal(verdict.status, 'inconclusive')
    assert.ok(verdict.basis.includes('拒绝判定'))
  })

  it('不满足适用前提的案例判 out-of-scope，避免跨分支误报', () => {
    const { result, facts } = factsOf(REAL)
    const other: Intent = { ...INTENT, appliesWhen: { labelContains: '这条日志不存在' } }
    const verdict = judgeCase(other, facts, result.verdict)
    assert.equal(verdict.status, 'out-of-scope')
    assert.equal(verdict.findings.length, 0)
  })

  it('期望成功的环节实际失败时报 failed-step', () => {
    const broken = REAL.split('\n')
      .map((line) => (line.includes('主档收敛') ? line.replace('INFO', 'ERROR').replace('主档收敛为 SUCCESS', '✗ VerificationServiceImpl.persist | 12ms | SQLException: deadlock') : line))
      .join('\n')
    const { result, facts } = factsOf(broken)
    const verdict = judgeCase(INTENT, facts, result.verdict)
    assert.notEqual(verdict.status, 'pass')
  })
})

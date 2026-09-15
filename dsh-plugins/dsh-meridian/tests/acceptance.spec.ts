/**
 * 真实验收回归测试 —— 用一次**真实代码改动**的 before/after 运行日志，锁住「行为变化可被检出」。
 *
 * 实验（2026-09-15，DSEDT 核验平台）：
 *   改动：`VerificationServiceImpl.CAS_MAX_ATTEMPTS` 3 → 2（乐观锁重试少一次）
 *   后果：单元测试失败（`setIfUnchanged` Wanted 3 times, got 2）
 *   事实：基线 39 个事件 → 改动后 38 个事件，首个分歧在第 3 个事件
 *
 * 本文件不干什么：不改动被观测项目（语料已固化为 fixture，实验后已按 sha256 字节级还原）。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildFingerprint, compareFingerprints } from '../src/features/fingerprint'
import { ingestLogText } from '../src/features/ingest'
import { DSEDT_PACK } from '../src/packs/dsedtJavaLogback'

/** 语料路径。 */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'acceptance-20260915')

/** 摄取并取首个案例的事件序列。 */
function eventsOf(file: string) {
  const text = readFileSync(join(FIXTURE, file), 'utf8')
  const result = ingestLogText(text, { source: file, pack: DSEDT_PACK })
  assert.equal(result.verdict, 'ok')
  return result.events
}

describe('真实验收闭环：AI 改代码 → 跑一次 → 行为变了没有', () => {
  it('检出「少做一步」并精确定位到首次分歧（与测试报错交叉一致）', () => {
    const before = eventsOf('before-cas3.log')
    const after = eventsOf('after-cas2.log')
    assert.equal(before.length, 39)
    assert.equal(after.length, 38)

    const delta = compareFingerprints(buildFingerprint(before), buildFingerprint(after))
    assert.equal(delta.kind, 'length-changed')
    assert.equal(delta.firstDivergence, 2, '首个分歧应在第 3 个事件（0 基=2）')

    // 两侧证据可回跳，且指出差异实质：基线有第 3 次 CAS 重试，改动后没有
    assert.ok(delta.baseSample?.label.includes('attempt=3/3'), String(delta.baseSample?.label))
    assert.ok(delta.currentSample?.label.includes('核验抢占未成功'), String(delta.currentSample?.label))
    assert.ok((delta.baseSample?.line ?? 0) > 0 && (delta.currentSample?.line ?? 0) > 0)
  })

  it('同一份代码重复运行判为「未变化」（避免把噪音当风险）', () => {
    const a = eventsOf('before-cas3.log')
    const b = eventsOf('before-cas3.log')
    assert.equal(compareFingerprints(buildFingerprint(a), buildFingerprint(b)).kind, 'identical')
  })
})

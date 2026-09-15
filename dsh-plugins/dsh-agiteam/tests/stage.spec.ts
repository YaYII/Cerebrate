/**
 * 阶段状态机单元测试 —— 验证九阶段流转、评审打回、进度计算。
 */

import { describe, expect, it } from 'vitest'
import {
  isReviewStage,
  isWorkStage,
  nextStage,
  progressOf,
  reviewBackTo,
  STAGE_NAMES,
  STAGE_ORDER,
} from '../src/features/stage'

describe('阶段状态机', () => {
  it('九阶段顺序完整（requirement → done）', () => {
    const expected = ['requirement', 'req-review', 'product', 'product-review', 'testcase', 'testcase-review', 'develop', 'feature-accept', 'e2e-accept', 'done']
    expect(STAGE_ORDER).toMatchObject(Object.fromEntries(expected.map((s, i) => [s, i])))
  })

  it('下一阶段正确（requirement → req-review … feature-accept → e2e-accept → done）', () => {
    expect(nextStage('requirement')).toBe('req-review')
    expect(nextStage('req-review')).toBe('product')
    expect(nextStage('product')).toBe('product-review')
    expect(nextStage('product-review')).toBe('testcase')
    expect(nextStage('testcase')).toBe('testcase-review')
    expect(nextStage('testcase-review')).toBe('develop')
    expect(nextStage('develop')).toBe('feature-accept')
    expect(nextStage('feature-accept')).toBe('e2e-accept')
    expect(nextStage('e2e-accept')).toBe('done')
    expect(nextStage('done')).toBeUndefined()
  })

  it('评审打回正确（req-review → requirement, product-review → product, testcase-review → testcase）', () => {
    expect(reviewBackTo('req-review')).toBe('requirement')
    expect(reviewBackTo('product-review')).toBe('product')
    expect(reviewBackTo('testcase-review')).toBe('testcase')
    expect(reviewBackTo('develop')).toBeUndefined()
  })

  it('阶段分类正确（评审/工作/交付）', () => {
    expect(isReviewStage('req-review')).toBe(true)
    expect(isReviewStage('product-review')).toBe(true)
    expect(isReviewStage('testcase-review')).toBe(true)
    expect(isReviewStage('develop')).toBe(false)
    expect(isWorkStage('requirement')).toBe(true)
    expect(isWorkStage('develop')).toBe(true)
    expect(isWorkStage('req-review')).toBe(false)
    expect(isWorkStage('done')).toBe(false)
  })

  it('进度计算单调递增', () => {
    const stages = Object.keys(STAGE_ORDER) as Array<keyof typeof STAGE_ORDER>
    for (let i = 1; i < stages.length; i++) {
      expect(progressOf(stages[i]!)).toBeGreaterThan(progressOf(stages[i - 1]!))
    }
    expect(progressOf('done')).toBe(1)
  })

  it('全部阶段有中文名', () => {
    for (const stage of Object.keys(STAGE_ORDER)) {
      expect(STAGE_NAMES[stage as keyof typeof STAGE_NAMES]).toBeTruthy()
    }
  })
})

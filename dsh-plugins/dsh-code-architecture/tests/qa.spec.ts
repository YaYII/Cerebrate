import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { qualityReport } from '../src/features/metrics'
import { generateGherkin, gherkinFeatureText } from '../src/features/gherkin'

/** 构造带业务层的项目。 */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'))
  mkdirSync(join(dir, 'src', 'utils'), { recursive: true })
  mkdirSync(join(dir, 'src', 'services'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'src', 'utils', 'helper.ts'), [
    '/** 工具：字符串处理。 */',
    'export function pad(s: string, n: number): string {',
    '  let r = s',
    '  for (let i = 0; i < n; i++) r = r + \' \'',
    '  return r',
    '}',
  ].join('\n'))
  writeFileSync(join(dir, 'src', 'services', 'order.ts'), [
    '/** 订单服务：创建订单。 */',
    "import { pad } from '../utils/helper'",
    'export function createOrder(id: string): string {',
    '  if (id.length === 0) throw new Error(\'id 为空\')',
    '  return pad(id, 1)',
    '}',
  ].join('\n'))
  writeFileSync(join(dir, 'tests', 'order.spec.ts'), 'import { it, expect } from \'vitest\'\nit(\'ok\', () => expect(1).toBe(1))')
  return dir
}

describe('质量体系', () => {
  it('qa_metrics：计算质量指标并判定门禁', () => {
    const dir = makeProject()
    try {
      const report = qualityReport(dir)
      expect(report.totals.files).toBeGreaterThanOrEqual(2)
      expect(report.gates.length).toBeGreaterThan(0)
      const testGate = report.gates.find(g => g.name === '测试存在性')
      expect(testGate?.pass).toBe(true)
      // 圈复杂度至少 1
      expect(report.totals.maxCyclomatic).toBeGreaterThanOrEqual(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('qa_gherkin：从业务层生成 BDD 场景', () => {
    const dir = makeProject()
    try {
      const scenarios = generateGherkin(dir)
      expect(scenarios.length).toBeGreaterThan(0)
      expect(scenarios[0]!.functionName).toBe('createOrder')
      expect(scenarios[0]!.scenarios.length).toBeGreaterThanOrEqual(3)
      const feature = gherkinFeatureText(scenarios)
      expect(feature).toContain('功能：')
      expect(feature).toContain('场景：')
      expect(feature).toContain('假如')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

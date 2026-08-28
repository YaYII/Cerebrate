/**
 * 埋点注入器单元测试：dryRun 预览、真实写入、备份回滚、注入语句格式。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanProject } from '../src/features/scanner'
import { generateLogPoints } from '../src/features/templates'
import { instrumentProject, revertProject, buildLogCall, planInjections, missingTargets } from '../src/features/instrument'
import type { LogPoint } from '../src/features/templates'

/** 构造带砖块与副作用函数的临时项目。 */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cog-inst-'))
  mkdirSync(join(dir, 'src/domain'), { recursive: true })
  writeFileSync(join(dir, 'src/domain/stock.ts'), [
    'export function 扣减库存(skuId: string, qty: number) {',
    '  const stock = readStock(skuId)',
    '  return stock - qty',
    '}',
    'function readStock(skuId: string) {',
    '  console.log("read", skuId)',
    '  return 100',
    '}',
  ].join('\n'), 'utf8')
  return dir
}

/** 一条测试埋点。 */
function point(phase: 'entry' | 'exit' | 'state-change', target = 'src/domain/stock.ts:扣减库存'): LogPoint {
  return {
    id: 'p1',
    target,
    kind: 'brick',
    phase,
    level: 'info',
    template: `[brick] ${phase}`,
    redact: [],
    ...phase === 'state-change' ? { sideEffect: 'console.' } : {},
  }
}

describe('instrument 注入', () => {
  it('buildLogCall 生成三类埋点语句', () => {
    expect(buildLogCall(point('entry'), ['skuId', "qty:'***'"])).toBe(
      "globalThis.__COG_LOG?.({k:'brick',p:'entry',id:'src/domain/stock.ts:扣减库存',a:{skuId,qty:'***'}})",
    )
    expect(buildLogCall(point('exit'))).toBe(
      "globalThis.__COG_LOG?.({k:'brick',p:'exit',id:'src/domain/stock.ts:扣减库存'})",
    )
    expect(buildLogCall(point('state-change'))).toContain("p:'state-change'")
    expect(buildLogCall(point('state-change'))).toContain("s:'console'")
  })

  it('dryRun 只产出 diff 不写盘', () => {
    const dir = makeProject()
    try {
      const scan = scanProject(dir)
      const points = generateLogPoints(scan)
      const result = instrumentProject(dir, points, { dryRun: true })
      expect(result.written).toBe(false)
      expect(result.diff).toContain('@@ src/domain/stock.ts')
      expect(result.diff).toContain('__COG_LOG')
      const src = readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')
      expect(src).not.toContain('__COG_LOG')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('真实写入注入三类埋点并生成备份', () => {
    const dir = makeProject()
    try {
      const scan = scanProject(dir)
      const points = generateLogPoints(scan)
      const result = instrumentProject(dir, points, { dryRun: false })
      expect(result.written).toBe(true)
      expect(result.backupDir).not.toBeNull()
      expect(existsSync(result.backupDir!)).toBe(true)
      const src = readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')
      expect(src).toContain("p:'entry'")
      expect(src).toContain("p:'exit'")
      expect(src).toContain("p:'state-change'")
      expect(src).toContain("s:'console'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('revert 恢复原始文件', () => {
    const dir = makeProject()
    try {
      const original = readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')
      const scan = scanProject(dir)
      const points = generateLogPoints(scan)
      const result = instrumentProject(dir, points, { dryRun: false })
      expect(readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')).not.toBe(original)
      const restored = revertProject(dir, result.backupDir!)
      expect(restored).toContain('src/domain/stock.ts')
      expect(readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')).toBe(original)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('planInjections 定位 entry/exit/state 三类注入点', () => {
    const dir = makeProject()
    try {
      // state-change 点在副作用所在函数（readStock 含 console）
      const byFile = planInjections(dir, [
        point('entry'),
        point('exit'),
        point('state-change', 'src/domain/stock.ts:readStock'),
      ])
      const injections = byFile.get('src/domain/stock.ts')!
      expect(injections.length).toBe(3)
      const entry = injections.find(i => i.text.includes("p:'entry'"))!
      const exit = injections.find(i => i.text.includes("p:'exit'"))!
      const state = injections.find(i => i.text.includes("p:'state-change'"))!
      expect(entry.offset).toBeLessThan(exit.offset)
      // state-change 点在 readStock（定义在扣减库存之后），offset 更大
      expect(state.offset).toBeGreaterThan(exit.offset)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('missingTargets 识别不存在的目标文件', () => {
    const dir = makeProject()
    try {
      const missing = missingTargets(dir, [point('entry', 'src/ghost.ts:foo')])
      expect(missing).toEqual(['src/ghost.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

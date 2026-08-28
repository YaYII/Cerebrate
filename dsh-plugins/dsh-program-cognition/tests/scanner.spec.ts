/**
 * 砖块分类器单元测试：五规则判定、分类正确性、副作用检测、依赖边。
 */
import { describe, expect, it } from 'vitest'
import { extractFunctions, analyzeFunction, scanProject, hasBusinessSemantic, detectSideEffects } from '../src/features/scanner'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 在临时目录创建项目并返回路径。 */
function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cog-scan-'))
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, src, 'utf8')
  }
  return dir
}

describe('scanner 分类', () => {
  it('中文纯计算函数判为砖块', () => {
    const src = 'export function 扣减库存(skuId: string, qty: number) { return skuId + qty }'
    const def = extractFunctions(src)[0]!
    const profile = analyzeFunction('src/a.ts', def, new Set())
    expect(profile.kind).toBe('brick')
    expect(profile.evidence).toContain('R1')
    expect(profile.evidence).toContain('R4')
    expect(profile.keywords.length).toBeGreaterThan(0)
  })

  it('业务语义英文名纯计算函数判为砖块', () => {
    const src = 'export function deductStock(skuId: string, qty: number) { return skuId }'
    const def = extractFunctions(src)[0]!
    const profile = analyzeFunction('src/a.ts', def, new Set())
    expect(profile.kind).toBe('brick')
    expect(hasBusinessSemantic('deductStock')).toBe(true)
  })

  it('通用工具函数判为 util', () => {
    const src = 'export function formatDate(d: Date) { return d.toISOString() }'
    const def = extractFunctions(src)[0]!
    const profile = analyzeFunction('src/a.ts', def, new Set())
    expect(profile.kind).toBe('util')
    expect(hasBusinessSemantic('formatDate')).toBe(false)
  })

  it('含网络请求的函数判为 service', () => {
    const src = 'export function fetchOrder(id: string) { return fetch("https://x/api/order/" + id) }'
    const def = extractFunctions(src)[0]!
    const profile = analyzeFunction('src/a.ts', def, new Set())
    expect(profile.kind).toBe('service')
    expect(profile.sideEffects).toContain('fetch')
  })

  it('含数据层词（Repository）的函数判为 service', () => {
    const src = 'export function saveOrder(o: unknown) { return orderRepository.save(o) }'
    const def = extractFunctions(src)[0]!
    const profile = analyzeFunction('src/a.ts', def, new Set())
    expect(profile.kind).toBe('service')
    expect(profile.sideEffects).toContain('Repository')
  })

  it('副作用检测识别强副作用与数据层词', () => {
    expect(detectSideEffects('console.log(1); process.exit()')).toContain('console')
    expect(detectSideEffects('await db.insert(row)')).toContain('insert')
    expect(detectSideEffects('return a + b')).toEqual([])
  })

  it('大函数且含业务语义标记隐式砖块', () => {
    const body = Array.from({ length: 70 }, (_, i) => `  if (x${i}) { total += ${i} }`).join('\n')
    const src = `export function 复杂下单(x: number) {\n${body}\n  return x }`
    const def = extractFunctions(src)[0]!
    const profile = analyzeFunction('src/a.ts', def, new Set())
    expect(profile.implicitBrick).toBe(true)
  })

  it('extractFunctions 提取多种函数形态且不重复', () => {
    const src = [
      'export function a() {}',
      'function b() {}',
      'const c = () => {}',
      'export const d = async (x: number) => { return x }',
      'const e = async function () {}',
    ].join('\n')
    const defs = extractFunctions(src)
    expect(defs.map(d => d.name).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(new Set(defs.map(d => d.name)).size).toBe(5)
  })

  it('scanProject 完整扫描：统计、档案、依赖边、跳过 node_modules、编排提升', () => {
    const dir = makeProject({
      'src/domain/stock.ts': 'export function 扣减库存(skuId: string) { return skuId }',
      'src/service/order.ts': 'export function 下单(userId: string) { 扣减库存(userId); return userId }',
      'src/util/format.ts': 'export function formatDate(d: Date) { return d.toISOString() }',
      'node_modules/x/index.ts': 'export function 不应出现() { return 1 }',
    })
    try {
      const scan = scanProject(dir)
      expect(scan.stats.files).toBe(3)
      expect(scan.stats.bricks).toBe(1)
      // 下单 调用 brick 被提升为 service；formatDate 保持 util
      expect(scan.stats.services).toBe(1)
      expect(scan.stats.utils).toBe(1)
      const order = scan.functions.find(f => f.name === '下单')!
      expect(order.kind).toBe('service')
      expect(order.evidence).toContain('S1')
      expect(order.calls).toContain('扣减库存')
      const stock = scan.functions.find(f => f.name === '扣减库存')!
      expect(stock.kind).toBe('brick')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

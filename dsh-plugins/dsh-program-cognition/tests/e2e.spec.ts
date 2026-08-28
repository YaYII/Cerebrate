/**
 * 端到端演示测试：在 examples/demo-shop 的临时副本上跑通
 * cog_scan → cog_instrument（dryRun + 写入）→ cog_trace → cog_graph → revert 全链路。
 * 使用临时副本，保证示例项目源码永远干净。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { cpSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeCogScan, executeCogInstrument, executeCogTrace, executeCogGraph } from '../src/business/tools'

/** 示例项目根目录（只读模板）与临时副本。 */
const DEMO_SRC = join(__dirname, '..', 'examples', 'demo-shop')
let DEMO = ''
const ARTIFACTS = () => join(DEMO, '.code-cognition')
const config = { artifactsDir: '.code-cognition' }

describe('demo-shop 端到端', () => {
  beforeAll(() => {
    DEMO = mkdtempSync(join(tmpdir(), 'cog-demo-'))
    cpSync(DEMO_SRC, DEMO, { recursive: true })
  })
  afterAll(() => { rmSync(DEMO, { recursive: true, force: true }) })

  it('cog_scan：砖块/服务/工具分类正确', async () => {
    const out = await executeCogScan(config, { project: DEMO })
    const data = out.data as Record<string, unknown>
    const stats = data.stats as Record<string, number>
    expect(stats.bricks).toBeGreaterThanOrEqual(2)      // 扣减库存/校验用户
    expect(stats.services).toBeGreaterThanOrEqual(1)    // 下单 + readStock
    expect(stats.utils).toBeGreaterThanOrEqual(1)       // formatMoney
    expect(existsSync(join(ARTIFACTS(), 'bricks.json'))).toBe(true)
  })

  it('cog_instrument：dryRun 预览不含写入，真实写入含三类埋点', async () => {
    const dry = await executeCogInstrument(config, { project: DEMO })
    expect((dry.data as Record<string, unknown>).written).toBe(false)
    const srcBefore = readFileSync(join(DEMO, 'src/service/order.ts'), 'utf8')
    expect(srcBefore).not.toContain('__COG_LOG')

    const real = await executeCogInstrument(config, { project: DEMO, dryRun: false })
    const data = real.data as Record<string, unknown>
    expect(data.written).toBe(true)
    const srcAfter = readFileSync(join(DEMO, 'src/service/order.ts'), 'utf8')
    expect(srcAfter).toContain('__COG_LOG')
    expect(srcAfter).toContain("p:'entry'")
  })

  it('cog_trace：运行入口采集行为时序链', async () => {
    const out = await executeCogTrace(config, { project: DEMO })
    const data = out.data as Record<string, unknown>
    expect(out.status).toBe('ok')
    expect(Number(data.recordCount)).toBeGreaterThan(0)
    const report = String(data.report)
    expect(report).toContain('行为时序链')
    expect(report).toContain('下单')
    expect(existsSync(join(ARTIFACTS(), 'behaviors.ndjson'))).toBe(true)
  })

  it('cog_graph：图谱聚合含语义注解（模板降级）', async () => {
    const out = await executeCogGraph(config, { project: DEMO, semantic: true })
    const data = out.data as Record<string, unknown>
    expect(Number(data.nodes)).toBeGreaterThanOrEqual(5)
    expect(String(data.semantic)).toContain('流转')
    expect(existsSync(join(ARTIFACTS(), 'graph.json'))).toBe(true)
  })

  it('cog_instrument revert：回滚后源码恢复原状', async () => {
    const original = readFileSync(join(DEMO, 'src/service/order.ts'), 'utf8')
    const afterWrite = await executeCogInstrument(config, { project: DEMO, dryRun: false })
    expect(readFileSync(join(DEMO, 'src/service/order.ts'), 'utf8')).not.toBe(original)
    const backupDir = String((afterWrite.data as Record<string, unknown>).backupDir)
    await executeCogInstrument(config, { project: DEMO, revert: backupDir })
    expect(readFileSync(join(DEMO, 'src/service/order.ts'), 'utf8')).toBe(original)
  })
})

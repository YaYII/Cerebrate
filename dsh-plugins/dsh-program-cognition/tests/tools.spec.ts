/**
 * 业务编排层端到端测试：临时项目上跑通
 * cog_scan → cog_instrument（dryRun + 写入 + revert）→ cog_trace → cog_graph → cog_agent。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  executeCogScan, executeCogInstrument, executeCogTrace, executeCogGraph,
  executeCogAgent, executeCogGuide,
} from '../src/business/tools'

/** 构造一个带完整业务链路的临时项目。 */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cog-tools-'))
  mkdirSync(join(dir, 'src/domain'), { recursive: true })
  mkdirSync(join(dir, 'src/service'), { recursive: true })
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
  writeFileSync(join(dir, 'src/service/order.ts'), [
    'export function 下单(userId: string) {',
    '  return 扣减库存(userId, 1)',
    '}',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, 'src/index.ts'), [
    'import { 下单 } from "./service/order.ts"',
    'export function main() {',
    '  return 下单("u1")',
    '}',
  ].join('\n'), 'utf8')
  return dir
}

const config = { artifactsDir: '.code-cognition' }

describe('tools 业务编排', () => {
  it('cog_scan 扫描并落盘 bricks.json', async () => {
    const dir = makeProject()
    try {
      const out = await executeCogScan(config, { project: dir })
      expect(out.status).toBe('ok')
      const data = out.data as Record<string, unknown>
      expect(existsSync(join(dir, '.code-cognition/bricks.json'))).toBe(true)
      expect(JSON.stringify(data.stats)).toContain('bricks')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cog_instrument dryRun 默认不写盘', async () => {
    const dir = makeProject()
    try {
      const out = await executeCogInstrument(config, { project: dir })
      const data = out.data as Record<string, unknown>
      expect(data.written).toBe(false)
      expect(String(data.diff)).toContain('__COG_LOG')
      const src = readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')
      expect(src).not.toContain('__COG_LOG')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cog_instrument 写入后 revert 回滚', async () => {
    const dir = makeProject()
    try {
      const before = readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')
      const out = await executeCogInstrument(config, { project: dir, dryRun: false })
      const data = out.data as Record<string, unknown>
      expect(data.written).toBe(true)
      expect(readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')).not.toBe(before)
      const backupDir = String(data.backupDir)
      const revertOut = await executeCogInstrument(config, { project: dir, revert: backupDir })
      expect(revertOut.status).toBe('ok')
      expect(readFileSync(join(dir, 'src/domain/stock.ts'), 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cog_trace 运行入口采集行为并落盘', async () => {
    const dir = makeProject()
    try {
      // 先注入埋点（否则无记录）
      await executeCogInstrument(config, { project: dir, dryRun: false })
      const out = await executeCogTrace(config, { project: dir })
      expect(out.status).toBe('ok')
      const data = out.data as Record<string, unknown>
      expect(Number(data.recordCount)).toBeGreaterThan(0)
      expect(existsSync(join(dir, '.code-cognition/behaviors.ndjson'))).toBe(true)
      expect(String(data.report)).toContain('行为时序链')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cog_graph 聚合图谱并支持语义注解（模板降级）', async () => {
    const dir = makeProject()
    try {
      const out = await executeCogGraph(config, { project: dir, semantic: true })
      expect(out.status).toBe('ok')
      const data = out.data as Record<string, unknown>
      expect(Number(data.nodes)).toBeGreaterThanOrEqual(3)
      expect(String(data.semantic)).toContain('行为数据')
      expect(existsSync(join(dir, '.code-cognition/graph.json'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cog_agent 无行为记录时返回提示', async () => {
    const dir = makeProject()
    try {
      const out = await executeCogAgent(config, { project: dir })
      expect(out.status).toBe('ok')
      const data = out.data as Record<string, unknown>
      expect(Number(data.recordCount)).toBe(0)
      expect(String(data.report)).toContain('暂无行为记录')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cog_agent 读取已有行为流并过滤', async () => {
    const dir = makeProject()
    try {
      // 手工写入两条行为记录
      mkdirSync(join(dir, '.code-cognition'), { recursive: true })
      writeFileSync(join(dir, '.code-cognition/agent-behaviors.ndjson'), [
        JSON.stringify({ key: 's1:1:1', sessionId: 's1', turn: 1, step: 1, kind: 'tool-call', ts: 1, summary: '调用 bash', toolName: 'bash', failed: false }),
        JSON.stringify({ key: 's1:1:1', sessionId: 's1', turn: 1, step: 1, kind: 'tool-result', ts: 2, summary: '失败: ECONNREFUSED', toolName: 'bash', failed: true }),
      ].join('\n'), 'utf8')
      const out = await executeCogAgent(config, { project: dir, sessionId: 's1' })
      const data = out.data as Record<string, unknown>
      expect(Number(data.recordCount)).toBe(2)
      const filtered = await executeCogAgent(config, { project: dir, sessionId: 's1', failed: true })
      expect(Number((filtered.data as Record<string, unknown>).recordCount)).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cog_guide 返回指引文本', async () => {
    const out = await executeCogGuide()
    const data = out.data as Record<string, unknown>
    expect(String(data.guide)).toContain('认知可观测性指引')
  })
})

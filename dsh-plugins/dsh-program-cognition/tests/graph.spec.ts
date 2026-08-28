/**
 * 认知图谱聚合器单元测试：节点/边/热点/gaps/焦点裁剪/报告。
 */
import { describe, expect, it } from 'vitest'
import { buildGraph, sliceGraph, graphReportText } from '../src/features/graph'
import type { ScanResult } from '../src/features/scanner'
import type { TraceRecord } from '../src/features/collector'

/** 构造最小扫描结果（两个砖块 + 一个 service，带依赖边）。 */
function fakeScan(): ScanResult {
  return {
    projectDir: '/fake',
    fileCount: 2,
    functions: [
      {
        id: 'src/order.ts:下单', file: 'src/order.ts', name: '下单', kind: 'service',
        evidence: ['R4'], keywords: ['下单'], inputs: [], output: 'void',
        sideEffects: ['fetch('], calls: ['扣减库存'], loc: 20, complexity: 3, implicitBrick: false,
      },
      {
        id: 'src/stock.ts:扣减库存', file: 'src/stock.ts', name: '扣减库存', kind: 'brick',
        evidence: ['R1', 'R2', 'R4'], keywords: ['扣减'], inputs: ['skuId'], output: 'void',
        sideEffects: [], calls: [], loc: 8, complexity: 2, implicitBrick: false,
      },
      {
        id: 'src/util.ts:formatDate', file: 'src/util.ts', name: 'formatDate', kind: 'util',
        evidence: ['R1'], keywords: [], inputs: [], output: 'void',
        sideEffects: [], calls: [], loc: 3, complexity: 1, implicitBrick: false,
      },
    ],
    stats: { bricks: 1, services: 1, utils: 1, unknowns: 0, files: 2 },
    findings: [],
  }
}

describe('graph 图谱', () => {
  it('静态调用边只在两端存在时建立', () => {
    const graph = buildGraph(fakeScan())
    expect(graph.edges).toContainEqual({ from: 'src/order.ts:下单', to: 'src/stock.ts:扣减库存', kind: 'call' })
    expect(graph.nodes.length).toBe(3)
    expect(graph.layers.brick).toBe(1)
    expect(graph.layers.util).toBe(1)
  })

  it('行为记录聚合热点与耗时', () => {
    const behaviors: TraceRecord[] = [
      { id: 'src/stock.ts:扣减库存', phase: 'entry', ts: 0 },
      { id: 'src/stock.ts:扣减库存', phase: 'exit', ts: 10, ms: 10 },
      { id: 'src/stock.ts:扣减库存', phase: 'entry', ts: 20 },
      { id: 'src/stock.ts:扣减库存', phase: 'exit', ts: 25, ms: 5 },
    ]
    const graph = buildGraph(fakeScan(), behaviors)
    const hot = graph.hotspots.find(h => h.id === 'src/stock.ts:扣减库存')!
    expect(hot.count).toBe(2)
    expect(hot.totalMs).toBe(15)
  })

  it('未观测依赖进入 gaps', () => {
    const graph = buildGraph(fakeScan(), [])
    expect(graph.gaps.length).toBe(1)
    expect(graph.gaps[0]!.to).toBe('src/stock.ts:扣减库存')
  })

  it('焦点裁剪保留邻域子图', () => {
    const graph = buildGraph(fakeScan())
    const sliced = sliceGraph(graph, 'src/order.ts:下单', 1)
    expect(sliced.nodes.map(n => n.id)).toContain('src/order.ts:下单')
    expect(sliced.nodes.map(n => n.id)).toContain('src/stock.ts:扣减库存')
    expect(sliced.nodes.map(n => n.id)).not.toContain('src/util.ts:formatDate')
  })

  it('报告文本包含关键板块', () => {
    const graph = buildGraph(fakeScan())
    graph.semantic = '下单流程：先扣减库存。'
    const text = graphReportText(graph)
    expect(text).toContain('程序认知图谱')
    expect(text).toContain('语义注解')
    expect(text).toContain('未观测依赖')
  })
})

/**
 * 认知图谱聚合器 —— 引擎 A + 引擎 B 的统一语义视图（cog_graph 的核心）。
 *
 * 节点 = 静态函数档案；边 = 静态调用依赖 + 动态行为父子（行为记录中的
 * entry/exit 配对近似调用关系）；gaps = 有静态依赖但零行为观测的边
 * （提示补测）；hotspots = 行为记录聚合的调用热点。语义翻译结果
 * （M6）作为图谱的 semantic 注解。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import type { ScanResult } from './scanner'
import type { TraceRecord } from './collector'

/** 图谱节点。 */
export interface GraphNode {
  id: string
  kind: string
  keywords: string[]
  loc: number
  /** 行为统计：调用次数。 */
  callCount: number
  /** 行为统计：总耗时（毫秒）。 */
  totalMs: number
}

/** 图谱边。 */
export interface GraphEdge {
  from: string
  to: string
  /** call = 静态调用依赖；behavior = 动态行为观测。 */
  kind: 'call' | 'behavior'
}

/** 认知图谱。 */
export interface CogGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  layers: { brick: number; service: number; util: number; unknown: number }
  hotspots: Array<{ id: string; count: number; totalMs: number }>
  /** 有静态依赖但零行为观测的边（提示补测）。 */
  gaps: GraphEdge[]
  /** 语义翻译结果（M6，可选）。 */
  semantic?: string
}

/**
 * 由扫描结果 + 行为记录聚合认知图谱。
 * @param scan - 扫描结果。
 * @param behaviors - 运行时行为记录（可为空）。
 * @returns 认知图谱。
 */
export function buildGraph(scan: ScanResult, behaviors: TraceRecord[] = []): CogGraph {
  const nodes: GraphNode[] = []
  const byId = new Map<string, GraphNode>()
  for (const fn of scan.functions) {
    const node: GraphNode = {
      id: fn.id,
      kind: fn.kind,
      keywords: fn.keywords,
      loc: fn.loc,
      callCount: 0,
      totalMs: 0,
    }
    nodes.push(node)
    byId.set(fn.id, node)
  }
  // 静态调用依赖边（仅在两端都存在时建边）
  const edges: GraphEdge[] = []
  for (const fn of scan.functions) {
    for (const callee of fn.calls) {
      const calleeId = scan.functions.find(f => f.name === callee)?.id
      if (calleeId && calleeId !== fn.id && !edges.some(e => e.from === fn.id && e.to === calleeId)) {
        edges.push({ from: fn.id, to: calleeId, kind: 'call' })
      }
    }
  }
  // 行为记录聚合：entry 配对统计调用次数与耗时
  const entryStack: Array<{ id: string; ts: number }> = []
  for (const rec of behaviors) {
    const node = byId.get(rec.id)
    if (!node) continue
    if (rec.phase === 'entry') {
      node.callCount++
      entryStack.push({ id: rec.id, ts: rec.ts })
    } else if (rec.phase === 'exit') {
      const top = entryStack.pop()
      if (top && top.id === rec.id && rec.ms !== undefined) node.totalMs += rec.ms
    }
  }
  const hotspots = nodes
    .filter(n => n.callCount > 0)
    .map(n => ({ id: n.id, count: n.callCount, totalMs: Math.round(n.totalMs) }))
    .sort((a, b) => b.totalMs - a.totalMs)
  // gaps：静态边两端均有档案但行为记录中从未观测到被调用端
  const observed = new Set(behaviors.map(b => b.id))
  const gaps = edges.filter(e => !observed.has(e.to))
  const layers = {
    brick: scan.functions.filter(f => f.kind === 'brick').length,
    service: scan.functions.filter(f => f.kind === 'service').length,
    util: scan.functions.filter(f => f.kind === 'util').length,
    unknown: scan.functions.filter(f => f.kind === 'unknown').length,
  }
  return { nodes, edges, layers, hotspots, gaps }
}

/**
 * 按焦点节点裁剪子图（focus/depth）。
 * @param graph - 完整图谱。
 * @param focus - 焦点节点 id（缺省返回全图）。
 * @param depth - 扩展深度（缺省 2）。
 * @returns 裁剪后的图谱（与完整图同构，仅节点/边变少）。
 */
export function sliceGraph(graph: CogGraph, focus?: string, depth = 2): CogGraph {
  if (!focus) return graph
  if (!graph.nodes.some(n => n.id === focus)) return graph
  const keep = new Set<string>([focus])
  const frontier = new Set<string>([focus])
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>()
    for (const node of frontier) {
      for (const e of graph.edges) {
        if (e.from === node && !keep.has(e.to)) { keep.add(e.to); next.add(e.to) }
        if (e.to === node && !keep.has(e.from)) { keep.add(e.from); next.add(e.from) }
      }
    }
    frontier.clear()
    for (const n of next) frontier.add(n)
  }
  return {
    nodes: graph.nodes.filter(n => keep.has(n.id)),
    edges: graph.edges.filter(e => keep.has(e.from) && keep.has(e.to)),
    layers: graph.layers,
    hotspots: graph.hotspots.filter(h => keep.has(h.id)),
    gaps: graph.gaps.filter(e => keep.has(e.from) && keep.has(e.to)),
    ...graph.semantic === undefined ? {} : { semantic: graph.semantic },
  }
}

/**
 * 生成认知图谱报告文本（中文，供 AI 直接阅读）。
 * @param graph - 认知图谱。
 * @returns 报告文本。
 */
export function graphReportText(graph: CogGraph): string {
  const lines: string[] = []
  lines.push('# 程序认知图谱')
  lines.push('')
  lines.push(`节点 ${graph.nodes.length} 个：砖块 ${graph.layers.brick} / 服务 ${graph.layers.service} / 工具 ${graph.layers.util} / 未分类 ${graph.layers.unknown}；边 ${graph.edges.length} 条。`)
  lines.push('')
  if (graph.semantic) {
    lines.push('## 语义注解（AI 翻译）')
    lines.push('')
    lines.push(graph.semantic)
    lines.push('')
  }
  lines.push('## 调用热点（行为观测）')
  lines.push('')
  if (graph.hotspots.length === 0) {
    lines.push('暂无行为观测 —— 运行 cog_trace 后热点将出现。')
  } else {
    lines.push('| 函数 | 调用次数 | 总耗时(ms) |')
    lines.push('|---|---|---|')
    for (const h of graph.hotspots.slice(0, 10)) lines.push(`| ${h.id} | ${h.count} | ${h.totalMs} |`)
  }
  lines.push('')
  lines.push('## 未观测依赖（gap，提示补测）')
  lines.push('')
  if (graph.gaps.length === 0) {
    lines.push('无 —— 所有静态依赖边均有行为覆盖。')
  } else {
    for (const g of graph.gaps.slice(0, 15)) lines.push(`- ${g.from} → ${g.to}`)
    if (graph.gaps.length > 15) lines.push(`- …（其余 ${graph.gaps.length - 15} 条）`)
  }
  lines.push('')
  lines.push('## 解读指引')
  lines.push('- 热点 = 业务高频路径，优先关注耗时与稳定性。')
  lines.push('- gap = 从未被观测的路径，可能是死代码或测试盲区，建议补场景。')
  return lines.join('\n')
}

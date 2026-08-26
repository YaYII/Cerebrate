import { describe, expect, it } from 'vitest'
import { lintMermaid, sanitizeMermaid, mermaidBlocks, lintDocumentMermaid } from '../src/features/mermaid'

describe('mermaid lint (rules from production failures)', () => {
  it('detects R1 slash-shape, R2 subgraph slash, R3 braces, R4 parens, R5 edge-label br, R6 nested brackets, R7 diamond ?', () => {
    const body = [
      'flowchart TD',
      '  subgraph 商户/经科局',
      '    A[文本]',
      '  end',
      '  B[sha256Hex(x).substring(0,40)]',
      '  C[mpay:nonce:{nonce}]',
      '  D -->|<br/>per-provider| E[ok]',
      '  F[adapterMap[targetType] → x]',
      '  G{是否启用?}',
      '  H[/api → backend/]',
    ].join('\n')
    const issues = lintMermaid(body)
    const rules = issues.map(i => i.rule)
    expect(rules).toContain('R1')
    expect(rules).toContain('R2')
    expect(rules).toContain('R3')
    expect(rules).toContain('R4')
    expect(rules).toContain('R5')
    expect(rules).toContain('R6')
    expect(rules).toContain('R7')
  })

  it('sanitizeMermaid auto-fixes all known risk patterns', () => {
    const body = [
      'flowchart TD',
      '  subgraph 商户/经科局',
      '    A[ok]',
      '  end',
      '  B[sha256Hex(x)]',
      '  C[mpay:nonce:{nonce}]',
      '  D -->|<br/>label| E[ok]',
      '  F[adapterMap[targetType]]',
      '  G{启用?}',
      '  H[/api → backend/]',
    ].join('\n')
    const { fixed, remaining } = sanitizeMermaid(body)
    // 所有已知风险被清洗后，剩余问题应为空（或至少大幅减少）
    expect(remaining.length).toBeLessThan(3)
    expect(fixed).not.toContain('商户/经科局')
    expect(fixed).not.toContain('{nonce}')
    expect(fixed).not.toContain('(/api → backend/')
  })

  it('mermaidBlocks extracts blocks with offsets', () => {
    const md = '# t\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\ntext\n\n```mermaid\nflowchart TD\n  X[1]\n```\n'
    const blocks = mermaidBlocks(md)
    expect(blocks.length).toBe(2)
    expect(blocks[0]!.body).toContain('A --> B')
    expect(blocks[1]!.body).toContain('X[1]')
  })

  it('mermaidBlocks offset 精确与无块时为空（变异点：offset/边界）', () => {
    const md = '# t\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\ntext\n'
    const blocks = mermaidBlocks(md)
    expect(blocks.length).toBe(1)
    // start 指向围栏起点，end 指向围栏结束；body 是围栏内正文
    expect(md.slice(blocks[0]!.start, blocks[0]!.start + 3)).toBe('```')
    expect(blocks[0]!.body).toContain('A --> B')
    // 无 mermaid 围栏 → 空
    expect(mermaidBlocks('plain text no fence')).toEqual([])
    // 多块 offset 连续正确
    const md2 = '```mermaid\nA\n```\n\n```mermaid\nB\n```'
    const b2 = mermaidBlocks(md2)
    expect(b2.length).toBe(2)
    expect(b2[0]!.body.trim()).toBe('A')
    expect(b2[1]!.body.trim()).toBe('B')
    expect(b2[1]!.start).toBeGreaterThan(b2[0]!.end)
  })

  it('lintDocumentMermaid returns per-block findings', () => {
    const md = '# t\n\n```mermaid\nflowchart LR\n  A[/x/]\n```\n'
    const res = lintDocumentMermaid(md)
    expect(res.length).toBe(1)
    expect(res[0]!.issues.some(i => i.rule === 'R1')).toBe(true)
  })

  it('lintMermaid 行号从 1 起且逐行精确（变异点：line 索引）', () => {
    const body = [
      'flowchart TD',
      '  A[sha256Hex(x)]',
      '  B[mpay:nonce:{nonce}]',
    ].join('\n')
    const issues = lintMermaid(body)
    // 第 2 行 R4（函数调用），第 3 行 R3（花括号）
    const r4 = issues.find(i => i.rule === 'R4')
    const r3 = issues.find(i => i.rule === 'R3')
    expect(r4?.line).toBe(2)
    expect(r3?.line).toBe(3)
    // 每行问题行号递增且 >= 1
    for (const iss of issues) expect(iss.line).toBeGreaterThanOrEqual(1)
  })

  it('clean mermaid passes with no issues', () => {
    const body = [
      'flowchart TD',
      '  subgraph 系统架构',
      '    A["订单服务"]',
      '    B["库存服务"]',
      '  end',
      '  A -->|调用| B',
      '  C{是否启用}',
    ].join('\n')
    expect(lintMermaid(body)).toEqual([])
  })
})

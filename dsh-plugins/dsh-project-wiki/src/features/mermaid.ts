/**
 * Mermaid 块的检查与清洗，面向 AI 撰写的知识库页面。
 *
 * 入口模块：只做编排（提取块、派发规则、应用修复）。
 * 规则零件（每个 R# 的检查器/修复器）在 mermaid-rules.ts——
 * 零件独立成文件后每个文件复杂度低、可独立测试。
 *
 * 每一条规则都提炼自真实生产知识库中的渲染失败案例（headless Chrome +
 * mermaid@11 引擎验证）：
 *   R1  [/text/] 形状语法在文本含 /（路径）时解析失败。
 *   R2  subgraph 标题不得含 /。
 *   R3  节点文本不得含未加引号的 { }（触发菱形解析）。
 *   R4  节点文本不得含 ( )（触发形状解析）。
 *   R5  边标签 |...| 不得含 <br/> 或 { }。
 *   R6  节点文本不得含嵌套 [ ] 或未转义双引号。
 *   R7  单独定义的菱形节点以 ? 结尾在某些解析器上有歧义。
 *   R8  节点定义残缺（] 后接 <br/> 文本再 ]）。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { LINE_CHECKERS, LINE_FIXERS, checkMindmap } from './mermaid-rules'

/** 一条检查发现。 */
export interface MermaidIssue {
  /** 稳定规则编号（R1..R8）。 */
  rule: string
  /** 块内行号（从 1 起）。 */
  line: number
  /** 可读的修复提示（中文）。 */
  hint: string
  /** sanitize() 是否可自动修复。 */
  autoFixable: boolean
}

/** 反引号字符（运行时生成，源码中不出现）。 */
function bt(): string {
  return String.fromCharCode(96)
}

/**
 * 从 markdown 文档中提取每个 mermaid 块。
 * 返回 start/end/body（围栏的字符偏移）。
 */
export function mermaidBlocks(markdown: string): Array<{ start: number; end: number; body: string; offset: number }> {
  const fence = bt() + bt() + bt()
  const out: Array<{ start: number; end: number; body: string; offset: number }> = []
  const re = new RegExp(fence + 'mermaid\\n([\\s\\S]*?)' + fence, 'g')
  for (const m of markdown.matchAll(re)) {
    const start = m.index!
    const body = m[1]!
    out.push({ start, end: start + m[0].length, body, offset: 0 })
  }
  return out
}

/** 逐行检查一个 mermaid 块正文（规则零件派发）。 */
export function lintMermaid(body: string): MermaidIssue[] {
  const issues: MermaidIssue[] = []
  const lines = body.split('\n')
  const add = (rule: string, i: number, hint: string, autoFixable = true) => {
    issues.push({ rule, line: i + 1, hint, autoFixable })
  }
  // 块类型判定：首行声明 mindmap 才启用 R9（思维导图语法与 flowchart 不同，
  // 花括号/斜杠在 flowchart 里是合法形状语法，不能误报）
  const isMindmap = (lines[0] ?? '').trim().startsWith('mindmap')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (!trimmed || trimmed.startsWith('%%')) continue
    // subgraph 行命中 R2 后跳过其余（标题行无节点）
    if (trimmed.startsWith('subgraph ')) {
      const title = trimmed.slice('subgraph '.length).trim()
      if (title.includes('/')) add('R2', i, 'subgraph 标题不能含斜杠 /，请改用「与」或引号包裹')
      continue
    }
    // mindmap 块：只派发 R9；其余块：派发 R1-R8（排除 R9）
    if (isMindmap) checkMindmap(trimmed, (r, h) => add(r, i, h))
    else for (const checker of LINE_CHECKERS) {
      if (checker === checkMindmap) continue
      checker(trimmed, (r, h) => add(r, i, h))
    }
  }
  return issues
}

/**
 * 就地自动修复一个 mermaid 块正文（规则零件应用，尽力而为）。
 * 返回修复后的正文与剩余问题。
 */
export function sanitizeMermaid(body: string): { fixed: string; remaining: MermaidIssue[] } {
  let s = body
  for (const fixer of LINE_FIXERS) s = fixer(s)
  return { fixed: s, remaining: lintMermaid(s) }
}

/** 校验 markdown 文档中的每个 mermaid 块；返回逐块问题。 */
export function lintDocumentMermaid(markdown: string): Array<{ block: number; issues: MermaidIssue[] }> {
  const blocks = mermaidBlocks(markdown)
  return blocks.map((b, i) => ({ block: i + 1, issues: lintMermaid(b.body) }))
}

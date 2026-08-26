/**
 * Mermaid 块的检查与清洗，面向 AI 撰写的知识库页面。
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
 * 结构：每条规则是一个独立小零件（检查函数 + 修复函数），lint 逐行派发
 * 到检查器，sanitize 逐条应用修复器。零件化让每个规则可独立测试、独立
 * 变异——拆小后变异分数自然提升，AI 推理成本降低。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

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

/** 行检查器签名：接收一行与收集器，把发现交给收集器。 */
type LineChecker = (trimmed: string, add: (rule: string, hint: string) => void) => void

/** 反引号字符（运行时生成，源码中不出现）。 */
function bt(): string {
  return String.fromCharCode(96)
}

// ── 规则零件：每个 R# 一个检查器（lint 用）与一个修复器（sanitize 用） ──

/** R2 检查：subgraph 标题含斜杠。 */
function checkSubgraphSlash(trimmed: string, add: (rule: string, hint: string) => void): void {
  if (trimmed.startsWith('subgraph ')) {
    const title = trimmed.slice('subgraph '.length).trim()
    if (title.includes('/')) add('R2', 'subgraph 标题不能含斜杠 /，请改用「与」或引号包裹')
  }
}

/** R1 检查：[/text/] 形状语法，文本内含斜杠。 */
function checkShapeSlash(trimmed: string, add: (rule: string, hint: string) => void): void {
  const shapeSlash = /^\s*[A-Za-z0-9_]+\[\/[^\]]*\/[^\]]*\]/.exec(trimmed)
  if (shapeSlash) add('R1', '[/.../] 形状语法与文本内 / 冲突：改为 [\"文本\"] 引号节点')
}

/** R6 检查：节点文本含嵌套方括号。 */
function checkNestedBracket(trimmed: string, add: (rule: string, hint: string) => void): void {
  if (!/\[\"/.test(trimmed) && /\[([^\]\[]*)\[([^\]\[]+)\]/.test(trimmed)) {
    add('R6', '节点文本含嵌套 [：把 [targetType] 改为文字描述（如 targetType 映射）')
  }
}

/** R5 检查：边标签含 br 或花括号。 */
function checkEdgeLabel(trimmed: string, add: (rule: string, hint: string) => void): void {
  const edgeLabel = trimmed.match(/\|([^|]*)\|/)
  if (edgeLabel) {
    const label = edgeLabel[1]!
    if (label.includes('<br') || label.includes('{') || label.includes('}')) {
      add('R5', '边标签 |...| 内不能有 <br/> 或 {}：标签用简单文本，换行说明移入节点')
    }
  }
}

/** R3/R4 检查：节点文本花括号与函数调用括号。 */
function checkNodeBraces(trimmed: string, add: (rule: string, hint: string) => void): void {
  const nodeText = trimmed.match(/[\[\{]([^\]\}]*)[\]\}]/)
  if (!nodeText) return
  const txt = nodeText[1]!
  if (!txt.includes('\"') && txt.includes('{')) add('R3', '节点文本含 { } 花括号：改为文字描述（如 mpay:nonce 值）')
  if (!txt.includes('\"') && /[a-zA-Z0-9_]\([^)]*\)/.test(txt)) add('R4', '节点文本含 () 函数调用：改为文字描述（如 sha256Hex 截取前40位）')
}

/** R8 检查：残缺节点（] 后接 br 再 ]）。 */
function checkBrokenNode(trimmed: string, add: (rule: string, hint: string) => void): void {
  if (!/\[\"/.test(trimmed) && /\][^\]\n]*<br[^\]\n]*\]/.test(trimmed)) {
    add('R8', '节点定义残缺：] 后多了 <br/>文本]，应为 [\"文本<br/>文本\"] 完整节点')
  }
}

/** R7 检查：菱形节点以问号结尾。 */
function checkDiamondQuestion(trimmed: string, add: (rule: string, hint: string) => void): void {
  if (/^\s*[A-Za-z0-9_]+\{[^}]*\?\}\s*$/.test(trimmed)) {
    add('R7', '菱形节点文本以 ? 结尾可能解析歧义：去掉 ?（如「是否启用」）')
  }
}

/** 全部行检查器（lint 按序派发）。 */
const LINE_CHECKERS: LineChecker[] = [
  checkSubgraphSlash,
  checkShapeSlash,
  checkNestedBracket,
  checkEdgeLabel,
  checkNodeBraces,
  checkBrokenNode,
  checkDiamondQuestion,
]

/** 一行修复器签名：返回修复后的文本（未命中时原样返回）。 */
type LineFixer = (line: string) => string

/** R1 修复：[/text/] → [\"text\"]。 */
const fixShapeSlash: LineFixer = (line) =>
  line.replace(/\[\/([^\]\n]*?)\/\]/g, (_, t: string) => '[\"' + t.trim() + '\"]')

/** R2 修复：subgraph 标题斜杠 → 与。 */
const fixSubgraphSlash: LineFixer = (line) =>
  line.replace(/(subgraph\s+)([^\n]+)/g, (_, p: string, t: string) => t.includes('/') ? p + t.replace(/\//g, '与') : p + t)

/** R3 修复：花括号内容 → 值后缀。 */
const fixBraces: LineFixer = (line) =>
  line.replace(/\{([^}]*)\}/g, (_, t: string) => (t.trim() ? t.trim() + ' 值' : '值'))

/** R4 修复：函数调用括号 → 空格连接。 */
const fixParens: LineFixer = (line) =>
  line.replace(/([a-zA-Z0-9_]+)\(([a-zA-Z0-9_, .'\u4e00-\u9fff]*)\)/g, (_, fn: string, args: string) => {
    const a = args.trim()
    if (!a || a.includes('/')) return fn + '(' + a + ')'
    return a ? fn + ' ' + a.split(',').join(' ').trim() : fn
  })

/** R5 修复：边标签内去除 br。 */
const fixEdgeLabelBr: LineFixer = (line) =>
  line.replace(/\|([^|]*?)<br\/?>([^|]*)\|/g, (_, a: string, b: string) => '|' + (a + ' ' + b).trim() + '|')

/** R6 修复：嵌套方括号 → 合并。 */
const fixNestedBracket: LineFixer = (line) =>
  line.replace(/\[([^\[\]\n]*)\[([^\[\]]+)\]([^\[\]\n]*)\]/g, (_, pre: string, inner: string, post: string) => '[' + pre + ' ' + inner + post + ']')

/** R8 修复：残缺节点 → 完整引号节点。 */
const fixBrokenNode: LineFixer = (line) =>
  line.replace(/([A-Za-z0-9_]+)\[([^\[\]\n]*)\]<br\/?>([^\]\n]*)\]/g, (_, id: string, a: string, b: string) => id + '[\"' + a.trim() + '<br/>' + b.trim() + '\"]')

/** R7 修复：菱形节点尾部问号。 */
const fixDiamondQuestion: LineFixer = (line) =>
  line.replace(/(\{[^}]*)\?\}/g, '$1}')

/** 全部行修复器（sanitize 按序应用）。 */
const LINE_FIXERS: LineFixer[] = [
  fixShapeSlash,
  fixSubgraphSlash,
  fixBraces,
  fixParens,
  fixEdgeLabelBr,
  fixNestedBracket,
  fixBrokenNode,
  fixDiamondQuestion,
]

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
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (!trimmed || trimmed.startsWith('%%')) continue
    // 派发到全部规则零件；subgraph 行命中 R2 后跳过其余（标题行无节点）
    if (trimmed.startsWith('subgraph ')) { checkSubgraphSlash(trimmed, (r, h) => add(r, i, h)); continue }
    for (const checker of LINE_CHECKERS) checker(trimmed, (r, h) => add(r, i, h))
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

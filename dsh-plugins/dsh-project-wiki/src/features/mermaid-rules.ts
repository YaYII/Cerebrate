/**
 * Mermaid 规则零件库：每个 R# 一个检查器（lint 用）与一个修复器（sanitize 用）。
 *
 * 从 mermaid.ts 拆出，让规则零件独立成文件——每个零件 ≤5 行、单一职责、
 * 独立可测。mermaid.ts 只留入口（blocks/lint/sanitize 编排）。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

/** 行检查器签名：接收一行与收集器，把发现交给收集器。 */
export type LineChecker = (trimmed: string, add: (rule: string, hint: string) => void) => void

/** 一行修复器签名：返回修复后的文本（未命中时原样返回）。 */
export type LineFixer = (line: string) => string

// ── 检查器零件 ──

/** R2 检查：subgraph 标题含斜杠。 */
export function checkSubgraphSlash(trimmed: string, add: (rule: string, hint: string) => void): void {
  if (trimmed.startsWith('subgraph ')) {
    const title = trimmed.slice('subgraph '.length).trim()
    if (title.includes('/')) add('R2', 'subgraph 标题不能含斜杠 /，请改用「与」或引号包裹')
  }
}

/** R1 检查：[/text/] 形状语法，文本内含斜杠。 */
export function checkShapeSlash(trimmed: string, add: (rule: string, hint: string) => void): void {
  const shapeSlash = /^\s*[A-Za-z0-9_]+\[\/[^\]]*\/[^\]]*\]/.exec(trimmed)
  if (shapeSlash) add('R1', '[/.../] 形状语法与文本内 / 冲突：改为 [\"文本\"] 引号节点')
}

/** R6 检查：节点文本含嵌套方括号。 */
export function checkNestedBracket(trimmed: string, add: (rule: string, hint: string) => void): void {
  if (!/\[\"/.test(trimmed) && /\[([^\]\[]*)\[([^\]\[]+)\]/.test(trimmed)) {
    add('R6', '节点文本含嵌套 [：把 [targetType] 改为文字描述（如 targetType 映射）')
  }
}

/** R5 检查：边标签含 br 或花括号。 */
export function checkEdgeLabel(trimmed: string, add: (rule: string, hint: string) => void): void {
  const edgeLabel = trimmed.match(/\|([^|]*)\|/)
  if (edgeLabel) {
    const label = edgeLabel[1]!
    if (label.includes('<br') || label.includes('{') || label.includes('}')) {
      add('R5', '边标签 |...| 内不能有 <br/> 或 {}：标签用简单文本，换行说明移入节点')
    }
  }
}

/** R3/R4 检查：节点文本花括号与函数调用括号。 */
export function checkNodeBraces(trimmed: string, add: (rule: string, hint: string) => void): void {
  const nodeText = trimmed.match(/[\[\{]([^\]\}]*)[\]\}]/)
  if (!nodeText) return
  const txt = nodeText[1]!
  if (!txt.includes('\"') && txt.includes('{')) add('R3', '节点文本含 { } 花括号：改为文字描述（如 mpay:nonce 值）')
  if (!txt.includes('\"') && /[a-zA-Z0-9_]\([^)]*\)/.test(txt)) add('R4', '节点文本含 () 函数调用：改为文字描述（如 sha256Hex 截取前40位）')
}

/** R8 检查：残缺节点（] 后接 br 再 ]）。 */
export function checkBrokenNode(trimmed: string, add: (rule: string, hint: string) => void): void {
  if (!/\[\"/.test(trimmed) && /\][^\]\n]*<br[^\]\n]*\]/.test(trimmed)) {
    add('R8', '节点定义残缺：] 后多了 <br/>文本]，应为 [\"文本<br/>文本\"] 完整节点')
  }
}

/** R7 检查：菱形节点以问号结尾。 */
export function checkDiamondQuestion(trimmed: string, add: (rule: string, hint: string) => void): void {
  if (/^\s*[A-Za-z0-9_]+\{[^}]*\?\}\s*$/.test(trimmed)) {
    add('R7', '菱形节点文本以 ? 结尾可能解析歧义：去掉 ?（如「是否启用」）')
  }
}

// ── 修复器零件 ──

/**
 * R1 修复：[/text/] 形状语法与文本内斜杠冲突（渲染器把 / 当形状结束符），
 * 统一改为引号节点——文本原样保留，形状语义由方括号表达。
 */
export const fixShapeSlash: LineFixer = (line) =>
  line.replace(/\[\/([^\]\n]*?)\/\]/g, (_, t: string) => '[\"' + t.trim() + '\"]')

/**
 * R2 修复：渲染器把 subgraph 标题中的 / 当层级分隔符（子图路径），导致标题断裂；
 * 用中文「与」替换是最贴近原意且无歧义的写法。
 */
export const fixSubgraphSlash: LineFixer = (line) =>
  line.replace(/(subgraph\s+)([^\n]+)/g, (_, p: string, t: string) => t.includes('/') ? p + t.replace(/\//g, '与') : p + t)

/**
 * R3 修复：{nonce} 会被渲染器当菱形节点（{...} 是菱形语法），导致节点变形；
 * 改写为「值 后缀」形态保留语义（mpay:nonce:{nonce} → mpay:nonce 值）。
 */
export const fixBraces: LineFixer = (line) =>
  line.replace(/\{([^}]*)\}/g, (_, t: string) => (t.trim() ? t.trim() + ' 值' : '值'))

/**
 * R4 修复：函数调用括号 () 会被渲染器当形状参数，导致节点解析错乱；
 * 改写为「函数名 参数」空格连接，语义不变、语法安全。
 */
export const fixParens: LineFixer = (line) =>
  line.replace(/([a-zA-Z0-9_]+)\(([a-zA-Z0-9_, .'\u4e00-\u9fff]*)\)/g, (_, fn: string, args: string) => {
    const a = args.trim()
    if (!a || a.includes('/')) return fn + '(' + a + ')'
    return a ? fn + ' ' + a.split(',').join(' ').trim() : fn
  })

/**
 * R5 修复：边标签 |...| 内的 <br/> 会被渲染器当标签分隔符，
 * 导致边标签断裂；改为空格连接（换行说明移入节点文本）。
 */
export const fixEdgeLabelBr: LineFixer = (line) =>
  line.replace(/\|([^|]*?)<br\/?>([^|]*)\|/g, (_, a: string, b: string) => '|' + (a + ' ' + b).trim() + '|')

/**
 * R6 修复：节点文本内的嵌套方括号 [a[b]] 会被渲染器当子节点定义，
 * 导致结构错乱；合并内层括号为文字描述。
 */
export const fixNestedBracket: LineFixer = (line) =>
  line.replace(/\[([^\[\]\n]*)\[([^\[\]]+)\]([^\[\]\n]*)\]/g, (_, pre: string, inner: string, post: string) => '[' + pre + ' ' + inner + post + ']')

/**
 * R8 修复：残缺节点（] 后接 <br/> 文本再 ]）是生成器拼接错误，
 * 渲染器直接失败；重建为完整引号节点。
 */
export const fixBrokenNode: LineFixer = (line) =>
  line.replace(/([A-Za-z0-9_]+)\[([^\[\]\n]*)\]<br\/?>([^\]\n]*)\]/g, (_, id: string, a: string, b: string) => id + '[\"' + a.trim() + '<br/>' + b.trim() + '\"]')

/**
 * R7 修复：菱形节点文本以 ? 结尾会被渲染器当条件语法的一部分，
 * 导致歧义；去掉尾部问号（语义由菱形形状表达）。
 */
export const fixDiamondQuestion: LineFixer = (line) =>
  line.replace(/(\{[^}]*)\?\}/g, '$1}')

/** 全部行检查器（lint 按序派发）。 */
export const LINE_CHECKERS: LineChecker[] = [
  checkSubgraphSlash,
  checkShapeSlash,
  checkNestedBracket,
  checkEdgeLabel,
  checkNodeBraces,
  checkBrokenNode,
  checkDiamondQuestion,
]

/** 全部行修复器（sanitize 按序应用）。 */
export const LINE_FIXERS: LineFixer[] = [
  fixShapeSlash,
  fixSubgraphSlash,
  fixBraces,
  fixParens,
  fixEdgeLabelBr,
  fixNestedBracket,
  fixBrokenNode,
  fixDiamondQuestion,
]

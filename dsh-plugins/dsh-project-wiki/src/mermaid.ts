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
 * sanitize() 应用安全重写；lint() 报告仍存在的风险，让调用方把警告
 * 呈现给 AI，而不是悄悄发布坏图。
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

/** 反引号字符（运行时生成，源码中不出现）。 */
function bt(): string {
  return String.fromCharCode(96)
}

/**
 * 从 markdown 文档中提取每个 ```mermaid 块。
 * 返回 [start, end, body] 三元组（围栏的字符偏移）。
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

/** 逐行检查一个 mermaid 块正文。 */
export function lintMermaid(body: string): MermaidIssue[] {
  const issues: MermaidIssue[] = []
  const lines = body.split('\n')
  const add = (rule: string, i: number, hint: string, autoFixable = true) => {
    issues.push({ rule, line: i + 1, hint, autoFixable })
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('%%')) continue

    // R2: subgraph 标题含 /
    if (trimmed.startsWith('subgraph ')) {
      const title = trimmed.slice('subgraph '.length).trim()
      if (title.includes('/')) add('R2', i, 'subgraph 标题不能含斜杠 /，请改用「与」或引号包裹')
      continue
    }

    // R1: [/text/] 形状语法，文本内含 /
    const shapeSlash = /^\s*[A-Za-z0-9_]+\[\/[^\]]*\/[^\]]*\]/.exec(trimmed)
    if (shapeSlash) add('R1', i, '[/.../] 形状语法与文本内 / 冲突：改为 [\"文本\"] 引号节点')

    // R6: 节点文本含嵌套 [（如 adapterMap[targetType]）
    if (!/\[\"/.test(trimmed) && /\[([^\]\[]*)\[([^\]\[]+)\]/.test(trimmed)) {
      add('R6', i, '节点文本含嵌套 [：把 [targetType] 改为文字描述（如 targetType 映射）')
    }

    // R5: 边标签 |...| 约束
    const edgeLabel = trimmed.match(/\|([^|]*)\|/)
    if (edgeLabel) {
      const label = edgeLabel[1]!
      if (label.includes('<br') || label.includes('{') || label.includes('}')) {
        add('R5', i, '边标签 |...| 内不能有 <br/> 或 {}：标签用简单文本，换行说明移入节点')
      }
    }

    // R3/R4: 节点文本的花括号与括号（跳过 subgraph 内部行；引号节点内安全）
    const nodeText = trimmed.match(/[\[\{]([^\]\}]*)[\]\}]/)
    if (nodeText) {
      const txt = nodeText[1]!
      if (!txt.includes('\"') && txt.includes('{')) add('R3', i, '节点文本含 { } 花括号：改为文字描述（如 mpay:nonce 值）')
      if (!txt.includes('\"') && /[a-zA-Z0-9_]\([^)]*\)/.test(txt)) add('R4', i, '节点文本含 () 函数调用：改为文字描述（如 sha256Hex 截取前40位）')
    }

    // R8: 残缺节点 —— ] 后接 <br/> 文本再 ]
    if (!/\[\"/.test(trimmed) && /\][^\]\n]*<br[^\]\n]*\]/.test(trimmed)) {
      add('R8', i, '节点定义残缺：] 后多了 <br/>文本]，应为 [\"文本<br/>文本\"] 完整节点')
    }

    // R7: 单独定义的菱形节点以 ? 结尾
    if (/^\s*[A-Za-z0-9_]+\{[^}]*\?\}\s*$/.test(trimmed)) {
      add('R7', i, '菱形节点文本以 ? 结尾可能解析歧义：去掉 ?（如「是否启用」）')
    }
  }
  return issues
}

/**
 * 就地自动修复一个 mermaid 块正文（尽力而为，保留结构）。
 * 返回修复后的正文与剩余问题。
 */
export function sanitizeMermaid(body: string): { fixed: string; remaining: MermaidIssue[] } {
  let s = body
  // R1: [/text/] → [\"text\"]（文本含 / 时）
  s = s.replace(/\[\/([^\]\n]*?)\/\]/g, (_, t: string) => '[\"' + t.trim() + '\"]')
  // R2: subgraph 标题斜杠 → 与
  s = s.replace(/(subgraph\s+)([^\n]+)/g, (_, p: string, t: string) => {
    if (t.includes('/')) return p + t.replace(/\//g, '与')
    return p + t
  })
  // R3: 节点文本花括号 → 去除（mpay:nonce:{nonce} → mpay:nonce 值）
  s = s.replace(/\{([^}]*)\}/g, (_, t: string) => (t.trim() ? t.trim() + ' 值' : '值'))
  // R4: 节点文本函数调用括号 → 去除（仅处理「方法名(参数)」形态且参数内不含 / 与 [）
  s = s.replace(/([a-zA-Z0-9_]+)\(([a-zA-Z0-9_, .'\u4e00-\u9fff]*)\)/g, (_, fn: string, args: string) => {
    const a = args.trim()
    if (!a || a.includes('/')) return fn + '(' + a + ')'
    return a ? fn + ' ' + a.split(',').join(' ').trim() : fn
  })
  // R5: 边标签内去除 <br/>
  s = s.replace(/\|([^|]*?)<br\/?>([^|]*)\|/g, (_, a: string, b: string) => '|' + (a + ' ' + b).trim() + '|')
  // R6: 节点文本嵌套括号 → 只删内层括号对
  s = s.replace(/\[([^\[\]\n]*)\[([^\[\]]+)\]([^\[\]\n]*)\]/g, (_, pre: string, inner: string, post: string) => {
    return '[' + pre + ' ' + inner + post + ']'
  })
  // R8: 残缺节点 —— ID[text]<br/>more] → ID["text<br/>more"]
  s = s.replace(/([A-Za-z0-9_]+)\[([^\[\]\n]*)\]<br\/?>([^\]\n]*)\]/g, (_, id: string, a: string, b: string) => id + '[\"' + a.trim() + '<br/>' + b.trim() + '\"]')
  // R7: 菱形节点尾部 ?
  s = s.replace(/(\{[^}]*)\?\}/g, '$1}')
  return { fixed: s, remaining: lintMermaid(s) }
}

/**
 * 校验 markdown 文档中的每个 mermaid 块；返回逐块问题供调用方呈现。
 */
export function lintDocumentMermaid(markdown: string): Array<{ block: number; issues: MermaidIssue[] }> {
  const blocks = mermaidBlocks(markdown)
  return blocks.map((b, i) => ({ block: i + 1, issues: lintMermaid(b.body) }))
}

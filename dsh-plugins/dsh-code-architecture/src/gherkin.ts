/**
 * Gherkin（BDD）场景生成器：从业务代码生成 Given/When/Then 骨架。
 *
 * BDD 让测试从「实现细节」提升到「业务行为」——读场景就能懂业务。
 * 本模块从业务层函数签名与文档注释提取行为，生成可执行的 BDD 骨架。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 一个 BDD 场景。 */
export interface GherkinScenario {
  file: string
  functionName: string
  /** 业务行为描述（来自文档注释或函数名推断）。 */
  feature: string
  scenarios: Array<{
    name: string
    given: string
    when: string
    then: string
  }>
}

/** 业务层目录标记。 */
const BUSINESS_DIRS = ['biz', 'business', 'services', 'service', 'controllers', 'controller', 'app', 'modules', 'module', 'domains', 'domain']

/** 收集业务层源文件。 */
function collectBusinessFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (['node_modules', '.git', 'dist', 'lib', '.code-arch', 'tests', 'coverage'].includes(name)) continue
      const abs = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) walk(abs)
      else if (/\.(ts|js|mjs)$/.test(name) && !name.endsWith('.spec.ts') && !name.endsWith('.test.ts')) {
        const rel = abs.slice(root.length + 1).replace(/\\/g, '/')
        if (rel.split('/').some(s => BUSINESS_DIRS.includes(s))) out.push(abs)
      }
    }
  }
  walk(root)
  return out.sort()
}

/** 提取函数的文档注释（函数前最近的 JSDoc/注释块）。 */
function docOf(text: string, fnIndex: number): string {
  const before = text.slice(0, fnIndex)
  const lines = before.split('\n')
  const docs: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim()
    if (t.startsWith('*') || t.startsWith('/**') || t.startsWith('//')) docs.unshift(t.slice(t.indexOf('*') + 1).replace(/(^\s*\/\/\s*)|(^\s*\/\*\*?\s*)|(\*\/\s*$)|(^\s*\*\s*)/g, '').trim())
    else break
  }
  return docs.join(' ').slice(0, 120)
}

/** 从函数名推断行为（驼峰 → 中文业务动作）。 */
function behaviorOf(fnName: string): string {
  const words = fnName.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/)
  const map: Record<string, string> = {
    create: '创建', get: '获取', list: '列出', update: '更新', delete: '删除', remove: '移除',
    verify: '核验', process: '处理', submit: '提交', cancel: '取消', confirm: '确认',
    check: '检查', validate: '校验', calculate: '计算', generate: '生成', parse: '解析',
    save: '保存', load: '加载', send: '发送', receive: '接收', start: '启动', stop: '停止',
  }
  const action = map[words[0] ?? ''] ?? words[0] ?? '处理'
  const target = words.slice(1).join('') || '数据'
  return action + target
}

/** 从业务文件生成 Gherkin 场景骨架。 */
export function generateGherkin(root: string): GherkinScenario[] {
  const files = collectBusinessFiles(root)
  const out: GherkinScenario[] = []
  for (const abs of files) {
    const rel = abs.slice(root.length + 1).replace(/\\/g, '/')
    const text = readFileSync(abs, 'utf8')
    const fnRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
    for (const m of text.matchAll(fnRe)) {
      const fnName = m[1]!
      const behavior = docOf(text, m.index!) || behaviorOf(fnName)
      out.push({
        file: rel,
        functionName: fnName,
        feature: behavior,
        scenarios: [
          {
            name: '正常路径：' + behavior,
            given: '存在合法的输入',
            when: '调用 ' + fnName,
            then: '返回预期结果，无异常',
          },
          {
            name: '异常路径：输入不合法',
            given: '输入缺失或格式错误',
            when: '调用 ' + fnName,
            then: '返回明确的错误或抛出可读异常',
          },
          {
            name: '边界路径：临界输入',
            given: '输入处于边界值',
            when: '调用 ' + fnName,
            then: '行为符合边界约定（不越界/不崩溃）',
          },
        ],
      })
    }
  }
  return out
}

/** 生成 Gherkin 特征文件文本（可直接用于 BDD 工具）。 */
export function gherkinFeatureText(scenarios: GherkinScenario[]): string {
  const lines: string[] = []
  for (const sc of scenarios) {
    lines.push('功能：' + sc.feature)
    lines.push('  作为调用方')
    lines.push('  我想要 ' + sc.functionName + ' 按预期工作')
    lines.push('  以便业务流转可靠')
    lines.push('')
    for (const s of sc.scenarios) {
      lines.push('  场景：' + s.name)
      lines.push('    假如 ' + s.given)
      lines.push('    当 ' + s.when)
      lines.push('    那么 ' + s.then)
      lines.push('')
    }
  }
  return lines.join('\n')
}

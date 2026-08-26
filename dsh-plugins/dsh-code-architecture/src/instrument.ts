/**
 * 源码级 AOP 插桩器：给目标模块的函数注入计时包裹，观测模块内部调用链。
 *
 * 原理：读取模块源码，把每个具名函数（export function / function / 箭头函数）
 * 改写为同名包裹——函数体首行注入 __AOP_PUSH(name)，return 前注入 __AOP_POP。
 * 运行时通过全局 globalThis.__AOP_PUSH/__AOP_POP 采集耗时与调用深度。
 *
 * 插桩后写入临时 .ts 文件（保留类型剥离能力），相对导入补 .ts 后缀。
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** 采集器代码：注入到插桩模块顶部。 */
const COLLECTOR = [
  'globalThis.__AOP_STACK = globalThis.__AOP_STACK ?? []',
  'globalThis.__AOP_RECORDS = globalThis.__AOP_RECORDS ?? []',
  'globalThis.__AOP_MAX_DEPTH = 50',
  'globalThis.__AOP_PUSH = globalThis.__AOP_PUSH ?? ((name) => {',
  '  if (globalThis.__AOP_STACK.length >= globalThis.__AOP_MAX_DEPTH) return',
  '  globalThis.__AOP_STACK.push({ name, t: Date.now() })',
  '})',
  'globalThis.__AOP_POP = globalThis.__AOP_POP ?? (() => {',
  '  const top = globalThis.__AOP_STACK.pop()',
  '  if (top) globalThis.__AOP_RECORDS.push({ name: top.name, ms: Date.now() - top.t, depth: globalThis.__AOP_STACK.length })',
  '})',
].join('\n')

/**
 * 插桩一个模块：包裹每个具名函数，记录调用耗时与深度。
 * 返回插桩后的完整源码（含采集器）。
 */
export function instrumentSource(src: string): string {
  // 1) 收集所有具名函数名（export function / function / const fn = async () => / const fn = function）
  const fnNames = new Set<string>()
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) fnNames.add(m[1]!)
  for (const m of src.matchAll(/(?<!export\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) fnNames.add(m[1]!)
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) fnNames.add(m[1]!)
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/g)) fnNames.add(m[1]!)

  let out = src
  // 2) 对每个函数：找到函数体首 { 与末 }（顶层），注入 PUSH/POP
  for (const name of fnNames) {
    // 只处理定义处（避免误伤调用处）：找 function name( 或 name = (
    const defRe = new RegExp(`(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\(|function))`)
    const dm = defRe.exec(out)
    if (!dm) continue
    const defIdx = dm.index + dm[0].length
    const openBrace = out.indexOf('{', defIdx)
    if (openBrace === -1) continue
    // 找配对的闭合 }（括号深度扫描）
    let depth = 0
    let closeBrace = -1
    for (let i = openBrace; i < out.length; i++) {
      const ch = out[i]!
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { closeBrace = i; break }
      }
    }
    if (closeBrace === -1) continue
    // 注入：{ 后插入 PUSH + try，} 前插入 finally POP
    const bodyStart = openBrace + 1
    const injectPush = `\n  globalThis.__AOP_PUSH?.(${JSON.stringify(name)});\n  try {`
    const injectPop = `} finally { globalThis.__AOP_POP?.(); }`
    out = out.slice(0, bodyStart) + injectPush + out.slice(bodyStart)
    // 注意：注入后闭合括号位置后移了 injectPush.length，重新定位
    const shiftedClose = closeBrace + injectPush.length
    out = out.slice(0, shiftedClose) + injectPop + out.slice(shiftedClose)
  }

  // 3) 相对导入补 .ts 后缀（Node ESM + strip-types 需要）
  out = out.replace(/from\s+['"]([^'"]+)['"]/g, (m: string, spec: string) => {
    if (spec.startsWith('.')) return m.replace(spec, spec.endsWith('.ts') ? spec : spec + '.ts')
    return m
  })

  return COLLECTOR + '\n' + out
}

/**
 * 插桩入口模块并写入临时文件，返回临时文件路径。
 */
export function instrumentFile(entryAbs: string): string {
  const src = readFileSync(entryAbs, 'utf8')
  // 递归插桩：入口及其所有相对导入的子模块，全部写入 .inst.ts
  const seen = new Set<string>()
  const instrumentRecursive = (abs: string): string => {
    if (seen.has(abs)) return abs.replace(/\.ts$/, '.inst.ts')
    seen.add(abs)
    let text = readFileSync(abs, 'utf8')
    const instAbs = abs.replace(/\.ts$/, '.inst.ts')
    // 递归处理相对导入（补 .ts 后缀并指向插桩版）
    text = text.replace(/from\s+['"]([^'"]+)['"]/g, (m: string, spec: string) => {
      if (!spec.startsWith('.')) return m
      const targetAbs = abs.includes('/')
        ? abs.slice(0, abs.lastIndexOf('/')) + '/' + (spec.endsWith('.ts') ? spec : spec + '.ts')
        : spec
      const targetInst = instrumentRecursive(targetAbs)
      return m.replace(spec, targetInst)
    })
    writeFileSync(instAbs, instrumentSource(text), 'utf8')
    return instAbs
  }
  return instrumentRecursive(entryAbs)
}

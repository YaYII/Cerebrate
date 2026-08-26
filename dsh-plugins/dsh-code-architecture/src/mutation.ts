/**
 * 变异测试引擎：注入代码变异体，验证测试能否抓到它们。
 *
 * 变异分数 = 被测试杀死的变异体 / 总变异体。低分数 = 测试是纸糊的
 * （代码坏了测试也看不出来）——这是「对代码有信心」的硬证据。
 *
 * 变异类型（对 TS/JS）：
 *   M1 常量替换（1 → 2）
 *   M2 算术运算符翻转（+ → -）
 *   M3 比较运算符翻转（=== → !==）
 *   M4 布尔翻转（true → false）
 *   M5 条件删除（if 条件改为 true）
 *   M6 短路逻辑翻转（&& → ||）
 *
 * @module @deepseek-ai/dsh-code-architecture
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 一个变异体。 */
export interface Mutant {
  id: number
  file: string
  line: number
  type: string
  original: string
  mutated: string
}

/** 变异测试结果。 */
export interface MutationResult {
  total: number
  killed: number
  survived: number
  /** 变异分数（0-1，越高测试越有效）。 */
  score: number
  /** 存活的变异体（测试没抓到 = 测试盲区）。 */
  survivors: Array<{ file: string; line: number; type: string; original: string }>
}

/** 变异规则：正则匹配 → 替换。 */
const MUTATORS: Array<{ type: string; find: RegExp; replace: (m: string) => string }> = [
  // M1 数字常量替换
  { type: 'M1-常量', find: /(\b\d+\b)/g, replace: m => String(Number(m) + 1) },
  // M2 算术翻转
  { type: 'M2-算术', find: /(\+|-|\*|\/)/g, replace: m => m === '+' ? '-' : m === '-' ? '+' : m === '*' ? '/' : '*' },
  // M3 比较翻转
  { type: 'M3-比较', find: /(===|!==|>=|<=)/g, replace: m => m === '===' ? '!==' : m === '!==' ? '===' : m === '>=' ? '<=' : '>=' },
  // M4 布尔翻转
  { type: 'M4-布尔', find: /(\btrue\b|\bfalse\b)/g, replace: m => m === 'true' ? 'false' : 'true' },
  // M5 条件恒真
  { type: 'M5-条件', find: /(if\s*\([^)]*\))/g, replace: () => 'if (true)' },
  // M6 逻辑翻转
  { type: 'M6-逻辑', find: /(&&|\|\|)/g, replace: m => m === '&&' ? '||' : '&&' },
]

/** 跳过无变异价值的行：import/export 声明、纯注释、空行、类型声明。 */
function isSkippableLine(line: string): boolean {
  const t = line.trim()
  if (t.length === 0) return true
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('/**')) return true
  if (t.startsWith('import ') || t.startsWith('export type') || t.startsWith('export interface')) return true
  if (t.startsWith('from ') || t.startsWith('export {') || t.startsWith('export *')) return true
  return false
}

/** 对一行生成全部适用的变异体（每条规则取首个命中，避免爆炸）。 */
function mutantsForLine(file: string, lineNo: number, line: string): Mutant[] {
  if (isSkippableLine(line)) return []
  const out: Mutant[] = []
  let id = 0
  for (const mut of MUTATORS) {
    const m = mut.find.exec(line)
    if (!m) continue
    const original = m[0]!
    // 跳过路径分隔符与字符串内的算术（如 import './x' 的 /）
    if (original === '/' && /['"]/.test(line.slice(0, m.index))) continue
    if (original === '*' && line.includes('**')) continue
    const mutated = mut.replace(original)
    if (mutated === original) continue
    out.push({ id, file, line: lineNo, type: mut.type, original, mutated })
    id++
  }
  return out
}

/**
 * 运行变异测试：对目标文件的代码行生成变异体，逐个注入跑测试，
 * 统计被杀/存活。测试命令可配置（默认 vitest run）。
 */
export function runMutation(opts: {
  project: string
  file?: string
  testCmd?: string
  testArgs?: string[]
  maxMutants?: number
  timeoutMs?: number
}): MutationResult {
  const { project } = opts
  const max = opts.maxMutants ?? 30
  const timeout = opts.timeoutMs ?? 120000
  const testArgs = opts.testArgs ?? ['run']

  // 1) 收集目标文件的变异体（默认全部源文件，限制数量）
  const mutants: Mutant[] = []
  const targetFile = opts.file ? join(project, opts.file) : null
  const collect = (dir: string) => {
    if (mutants.length >= max) return
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (mutants.length >= max) return
      if (['node_modules', '.git', 'dist', 'lib', '.code-arch', 'tests', 'coverage'].includes(name)) continue
      const abs = join(dir, name)
      const st = statSync(abs)
      if (st.isDirectory()) collect(abs)
      else if (/^.*\.(ts|js|mjs)$/.test(name) && !name.endsWith('.spec.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
        if (targetFile && abs !== targetFile) continue
        const lines = readFileSync(abs, 'utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          const rel = abs.slice(project.length + 1).replace(/\\/g, '/')
          for (const mut of mutantsForLine(rel, i + 1, lines[i]!)) {
            mutants.push({ ...mut, id: mutants.length })
            if (mutants.length >= max) break
          }
        }
      }
    }
  }
  collect(project)
  if (mutants.length === 0) return { total: 0, killed: 0, survived: 0, score: 0, survivors: [] }

  // 2) 基线：先跑一次原代码测试，确认通过（否则变异测试无意义）
  const runTest = (): boolean => {
    try {
      execFileSync('node', [join(project, 'node_modules/vitest/vitest.mjs'), ...testArgs], {
        cwd: project, timeout, encoding: 'utf8', stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }
  const baselinePass = runTest()
  if (!baselinePass) {
    return { total: 0, killed: 0, survived: 0, score: 0, survivors: [], ...({ baselineFailed: true } as object) }
  }

  // 3) 逐个变异体：注入 → 跑测试 → 判定
  const byFile = new Map<string, { abs: string; original: string }>()
  const mkAbs = (rel: string) => join(project, rel)
  let killed = 0
  const survivors: MutationResult['survivors'] = []
  for (const mut of mutants) {
    const abs = mkAbs(mut.file)
    let orig = byFile.get(mut.file)?.original
    if (!orig) {
      orig = readFileSync(abs, 'utf8')
      byFile.set(mut.file, { abs, original: orig })
    }
    // 注入变异（替换该行首个命中）
    const lines = orig.split('\n')
    const targetLine = lines[mut.line - 1]!
    const mutatedLine = targetLine.replace(mut.original, mut.mutated)
    if (mutatedLine === targetLine) { survivors.push({ file: mut.file, line: mut.line, type: mut.type, original: mut.original }); continue }
    lines[mut.line - 1] = mutatedLine
    writeFileSync(abs, lines.join('\n'), 'utf8')
    // 跑测试：被杀 = 测试失败（捕获了变异）
    const caught = !runTest()
    // 还原
    writeFileSync(abs, orig, 'utf8')
    if (caught) killed++
    else survivors.push({ file: mut.file, line: mut.line, type: mut.type, original: mut.original })
  }
  const total = mutants.length
  return {
    total,
    killed,
    survived: survivors.length,
    score: total === 0 ? 0 : Math.round(killed / total * 100) / 100,
    survivors: survivors.slice(0, 15),
  }
}

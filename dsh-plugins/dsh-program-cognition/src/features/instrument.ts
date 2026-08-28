/**
 * 源码埋点注入器 —— 把埋点配置写入真实源码（dryRun 默认，可回滚）。
 *
 * 安全设计（决策 #3）：dryRun 时只产出 diff 预览文本；真实写入前
 * 自动备份原文件到 .code-cognition/backup/<时间戳>/，revertProject 可恢复。
 * 注入的调用统一为 `globalThis.__COG_LOG?.(...)` 可选链形式——
 * 目标项目没有采集器时静默跳过，不破坏业务语义；采集器由 cog_trace
 * 运行时注入（见 collector.ts）。
 *
 * 注入位置（复用 scanner 的函数体 offset 定位）：
 * - entry：函数体开括号后的行首；
 * - exit：函数体闭括号前；
 * - state-change：函数体内副作用词命中行的行首。
 * 多个注入点按偏移从后往前插入，避免位置漂移。
 *
 * @module @deepseek-ai/dsh-program-cognition
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LogPoint } from './templates'
import { extractFunctions, collectSourceFiles } from './scanner'

/** 注入结果。 */
export interface InstrumentResult {
  /** 实际注入的埋点。 */
  points: LogPoint[]
  /** 变更预览（diff 风格文本，dryRun 与写入时都产出）。 */
  diff: string
  /** 是否真实写入了文件（dryRun 时恒为 false）。 */
  written: boolean
  /** 写入的文件相对路径列表。 */
  writtenFiles: string[]
  /** 备份目录（真实写入时非空，可回滚）。 */
  backupDir: string | null
}

/** 注入选项。 */
export interface InstrumentOptions {
  /** 默认 true：只产出 diff 预览，不写盘。 */
  dryRun: boolean
}

/**
 * 生成一条埋点的注入语句。
 * @param point - 埋点配置。
 * @param argRefs - 入口埋点的参数变量引用列表（黑名单参数已替换为 *** 字面量）。
 * @returns 注入代码文本。
 */
export function buildLogCall(point: LogPoint, argRefs: string[] = []): string {
  const id = point.target
  if (point.phase === 'entry') {
    const argsObj = argRefs.length > 0 ? `,a:{${argRefs.join(',')}}` : ''
    return `globalThis.__COG_LOG?.({k:'${point.kind}',p:'entry',id:'${id}'${argsObj}})`
  }
  if (point.phase === 'exit') {
    return `globalThis.__COG_LOG?.({k:'${point.kind}',p:'exit',id:'${id}'})`
  }
  return `globalThis.__COG_LOG?.({k:'${point.kind}',p:'state-change',id:'${id}',s:'${(point.sideEffect ?? '').replace(/\W+$/, '')}'})`
}

/** 注入点：目标文件 + 插入偏移 + 插入文本。 */
interface Injection {
  file: string
  offset: number
  text: string
}

/**
 * 计算全部注入点（含 entry 的参数引用、state-change 的行定位）。
 * @param projectDir - 项目根目录。
 * @param points - 埋点配置。
 * @returns 按文件分组的注入点列表。
 */
export function planInjections(projectDir: string, points: LogPoint[]): Map<string, Injection[]> {
  const byFile = new Map<string, Injection[]>()
  const srcCache = new Map<string, string>()
  const getSrc = (file: string): string | null => {
    if (srcCache.has(file)) return srcCache.get(file) ?? null
    try {
      const src = readFileSync(join(resolve(projectDir), file), 'utf8')
      srcCache.set(file, src)
      return src
    } catch {
      srcCache.set(file, '')
      return null
    }
  }
  for (const point of points) {
    const [file, name] = [point.target.slice(0, point.target.lastIndexOf(':')), point.target.slice(point.target.lastIndexOf(':') + 1)]
    const src = getSrc(file)
    if (src === null) continue
    const def = extractFunctions(src).find(d => d.name === name)
    if (!def) continue
    const list = byFile.get(file) ?? []
    if (point.phase === 'entry') {
      // 入口：开括号后的行首；参数引用（黑名单参数以 *** 字面量占位）
      const refs = def.argsText.split(',').map(a => a.trim().split(':')[0]!.trim())
        .filter(a => /^[A-Za-z_$][\w$]*$/.test(a))
      const argsText = refs.map(a => {
        const lower = a.toLowerCase()
        const redacted = [...point.redact, ...REDACT_EXTRA].some(r => lower.includes(r))
        return redacted ? `${a}:'***'` : a
      })
      const call = buildLogCall(point, argsText)
      const newlineAt = src.indexOf('\n', def.bodyStart)
      const offset = newlineAt === -1 ? def.bodyStart + 1 : newlineAt + 1
      list.push({ file, offset, text: `  ${call}\n` })
    } else if (point.phase === 'exit') {
      const call = buildLogCall(point)
      list.push({ file, offset: def.bodyEnd, text: `\n  ${call}\n` })
    } else {
      // 状态变更：函数体内副作用词首次命中行的行首
      const word = point.sideEffect ?? ''
      const body = src.slice(def.bodyStart, def.bodyEnd + 1)
      const idx = word ? body.indexOf(word) : -1
      if (idx === -1) continue
      const absIdx = def.bodyStart + idx
      const lineStart = src.lastIndexOf('\n', absIdx) + 1
      const call = buildLogCall(point)
      list.push({ file, offset: lineStart, text: `  ${call}\n` })
    }
    byFile.set(file, list)
  }
  return byFile
}

/** 附加脱敏键（与 redact 黑名单合并的轻量实现，避免循环依赖）。 */
const REDACT_EXTRA = ['password', 'token', 'secret', 'api', 'phone', 'idcard', '身份证', '密码']

/**
 * 执行注入。
 * @param projectDir - 项目根目录。
 * @param points - 埋点配置。
 * @param options - 注入选项（dryRun 默认 true）。
 * @returns 注入结果。
 */
export function instrumentProject(projectDir: string, points: LogPoint[], options: InstrumentOptions = { dryRun: true }): InstrumentResult {
  const abs = resolve(projectDir)
  const byFile = planInjections(abs, points)
  const diffParts: string[] = []
  const writtenFiles: string[] = []
  let backupDir: string | null = null

  if (options.dryRun) {
    for (const [file, injections] of byFile) {
      const src = readFileSync(join(abs, file), 'utf8')
      const lines = src.split('\n')
      const parts = [`@@ ${file}`]
      for (const inj of injections) {
        const lineNo = src.slice(0, inj.offset).split('\n').length
        parts.push(`  +L${lineNo}: ${inj.text.trim()}`)
      }
      diffParts.push(parts.join('\n'))
      // 预览行号基于原文件行号
      void lines
    }
    return { points, diff: diffParts.join('\n\n'), written: false, writtenFiles: [], backupDir: null }
  }

  // 真实写入：先备份，再从后往前插入
  const ts = Date.now().toString(36)
  const backupRoot = join(abs, '.code-cognition', 'backup', ts)
  const files = [...byFile.keys()]
  for (const file of files) {
    const srcPath = join(abs, file)
    if (!existsSync(srcPath)) continue
    const backupPath = join(backupRoot, file)
    mkdirSync(join(backupPath, '..'), { recursive: true })
    copyFileSync(srcPath, backupPath)
    const injections = byFile.get(file)!.sort((a, b) => b.offset - a.offset)
    let out = srcPath === srcPath ? readFileSync(srcPath, 'utf8') : ''
    // 重新读取避免多文件互相影响（各文件独立）
    out = readFileSync(srcPath, 'utf8')
    for (const inj of injections) {
      const lineNo = out.slice(0, inj.offset).split('\n').length
      out = out.slice(0, inj.offset) + inj.text + out.slice(inj.offset)
      diffParts.push(`@@ ${file}\n  +L${lineNo}: ${inj.text.trim()}`)
    }
    writeFileSync(srcPath, out, 'utf8')
    writtenFiles.push(file)
  }
  backupDir = existsSync(backupRoot) ? backupRoot : null
  return { points, diff: diffParts.join('\n'), written: true, writtenFiles, backupDir }
}

/**
 * 从备份目录恢复文件（回滚埋点注入）。
 * @param projectDir - 项目根目录。
 * @param backupDir - 备份目录绝对路径（instrumentProject 返回值）。
 * @returns 恢复的文件相对路径列表。
 */
export function revertProject(projectDir: string, backupDir: string): string[] {
  const abs = resolve(projectDir)
  const restored: string[] = []
  if (!existsSync(backupDir)) return restored
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const relPath = rel ? join(rel, name) : name
      if (statSync(full).isDirectory()) walk(full, relPath)
      else {
        copyFileSync(full, join(abs, relPath))
        restored.push(relPath)
      }
    }
  }
  walk(backupDir, '')
  return restored
}

/**
 * 校验：重扫项目文件列表，确认埋点目标文件存在（防止注入幽灵文件）。
 * @param projectDir - 项目根目录。
 * @param points - 埋点配置。
 * @returns 不存在的目标文件列表。
 */
export function missingTargets(projectDir: string, points: LogPoint[]): string[] {
  const files = new Set(collectSourceFiles(projectDir))
  return [...new Set(points.map(p => p.target.slice(0, p.target.lastIndexOf(':'))))].filter(f => !files.has(f))
}

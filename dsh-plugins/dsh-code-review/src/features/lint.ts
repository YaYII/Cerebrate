/**
 * 静态 lint / format 执行与输出归一化。
 *
 * lint 输出（ESLint JSON、tsc 文本，以及未来的 checkstyle/ruff/phpcs）被
 * 归一化为与语言无关的 `Finding[]` 形状。格式检查报告哪些文件有差异。
 * @module @deepseek-ai/dsh-code-review
 */

import { join, relative } from 'node:path'
import { runCommand } from './runner'
import { resolveBin, type Toolchain } from './languages'
import type { Finding, Severity } from './types'

/** 归一化的静态检查结果。 */
export interface LintOutcome {
  findings: Finding[]
  /** linter 是否完整运行；二进制缺失时为 false。 */
  ran: boolean
  /** 原始退出码。 */
  exitCode: number | null
  /** 原始工具输出尾部，供报告附录使用。 */
  rawTail: string
  /** 工具无法运行的原因。 */
  error?: string
}

/** 归一化的格式检查结果。 */
export interface FormatOutcome {
  /** 所有文件都已格式化（或格式化器通过）时为 true。 */
  clean: boolean
  ran: boolean
  exitCode: number | null
  /** 被报告为需要格式化的文件。 */
  dirtyFiles: string[]
  rawTail: string
  error?: string
}

const ESLINT_SEVERITY_TO_LEVEL: Record<number, Severity> = { 2: 'P1', 1: 'P2', 0: 'P3' }

/**
 * 在 `projectDir` 运行工具链的 linter 并归一化其输出。已接入 ESLint（JSON）
 * 与 tsc（文本）解析器；未知工具回退为带明确备注的原始输出，保证报告诚实。
 * @param projectDir - 项目根目录。
 * @param toolchain - 匹配到的工具链。
 * @param tool - 运行哪个 lint 变体（`lint` 或 `tsc`）。
 * @returns 归一化的发现列表。
 */
export async function runLint(
  projectDir: string,
  toolchain: Toolchain,
  tool: 'lint' | 'tsc' = 'lint',
): Promise<LintOutcome> {
  const spec = tool === 'tsc' ? { bin: 'tsc', args: ['--noEmit'] } : toolchain.lint
  if (!spec) {
    return { findings: [], ran: false, exitCode: null, rawTail: '', error: `no lint command for ${toolchain.language}` }
  }
  const bin = resolveBin(projectDir, spec.bin)
  const result = await runCommand(bin, spec.args, { cwd: projectDir, timeoutMs: 120_000 })

  let findings: Finding[] = []
  let parseError: string | undefined
  if (tool === 'tsc') {
    findings = parseTscOutput(result.stdout)
  } else if (toolchain.language === 'js-ts' && spec.bin === 'eslint') {
    findings = parseEslintJson(result.stdout, projectDir)
  } else if (toolchain.language === 'python' && spec.bin === 'ruff') {
    findings = parseRuffText(result.stdout, projectDir)
  } else {
    parseError = `no parser wired for ${spec.bin} yet — raw output returned`
  }

  return {
    findings,
    ran: true,
    exitCode: result.exitCode,
    rawTail: result.stdout.slice(-2000),
    ...(parseError !== undefined ? { error: parseError } : {}),
  }
}

/** 以检查模式运行格式化器。 */
export async function runFormat(projectDir: string, toolchain: Toolchain): Promise<FormatOutcome> {
  const spec = toolchain.format
  if (!spec) {
    return { clean: true, ran: false, exitCode: null, dirtyFiles: [], rawTail: '', error: `no format command for ${toolchain.language}` }
  }
  const bin = resolveBin(projectDir, spec.bin)
  const result = await runCommand(bin, spec.args, { cwd: projectDir, timeoutMs: 120_000 })
  const dirtyFiles = extractDirtyFiles(result.stdout, result.stderr)
  return {
    clean: result.exitCode === 0,
    ran: true,
    exitCode: result.exitCode,
    dirtyFiles,
    rawTail: `${result.stdout}\n${result.stderr}`.slice(-2000),
  }
}

/** 解析 ESLint `--format json` 输出。 */
export function parseEslintJson(output: string, projectDir: string): Finding[] {
  try {
    const data = JSON.parse(output) as Array<{
      filePath: string
      messages?: Array<{ line?: number; column?: number; ruleId?: string | null; severity?: number; message?: string }>
    }>
    const findings: Finding[] = []
    for (const file of data) {
      for (const message of file.messages ?? []) {
        const severity = ESLINT_SEVERITY_TO_LEVEL[message.severity ?? 1] ?? 'P2'
        findings.push({
          tool: 'eslint',
          severity,
          file: relative(projectDir, file.filePath) || file.filePath,
          ...(message.line !== undefined ? { line: message.line } : {}),
          ...(message.column !== undefined ? { column: message.column } : {}),
          ...(message.ruleId !== undefined && message.ruleId !== null ? { rule: message.ruleId } : {}),
          message: message.message ?? '(no message)',
        })
      }
    }
    return findings
  } catch {
    return []
  }
}

/** 解析 `tsc --noEmit` 文本输出：`path(line,col): error TS1234: msg`。 */
export function parseTscOutput(output: string): Finding[] {
  const findings: Finding[] = []
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm
  for (const match of output.matchAll(pattern)) {
    const rule = match[4]
    findings.push({
      tool: 'tsc',
      severity: 'P1',
      file: match[1] ?? '(unknown)',
      line: Number(match[2]),
      column: Number(match[3]),
      ...(rule !== undefined ? { rule } : {}),
      message: match[5] ?? '',
    })
  }
  return findings
}

/** 解析 `ruff check` 文本输出：`path:line:col: code msg`。 */
export function parseRuffText(output: string, projectDir: string): Finding[] {
  const findings: Finding[] = []
  const pattern = /^(.+?):(\d+):(\d+):\s+(\w+)\s+(.+)$/gm
  for (const match of output.matchAll(pattern)) {
    const file = match[1] ?? ''
    const rule = match[4] ?? ''
    const isError = /^E[0-9]+|^F[0-9]+|^B[0-9]+/.test(rule)
    findings.push({
      tool: 'ruff',
      severity: isError ? 'P1' : 'P2',
      file: file.startsWith('.') ? relative(projectDir, join(projectDir, file)) : file,
      line: Number(match[2]),
      column: Number(match[3]),
      rule,
      message: match[5] ?? '',
    })
  }
  return findings
}

/** 启发式地从格式化器输出中提取需要格式化的文件。 */
export function extractDirtyFiles(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`
  const files: string[] = []
  // prettier --check："path/file.ts" 单独成行（未格式化的文件被列出；
  // 其余是汇总行）。
  const pattern = /^([^\s]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|json|css|scss|less|md|py|java|php))$/gm
  for (const match of combined.matchAll(pattern)) {
    const candidate = match[1] ?? ''
    if (!candidate.includes('All matched')) files.push(candidate)
  }
  return [...new Set(files)]
}

/**
 * Static lint / format execution and output normalization.
 *
 * Linter outputs (ESLint JSON, tsc text, and future checkstyle/ruff/phpcs)
 * are normalized into the language-agnostic `Finding[]` shape. Format check
 * reports which files differ.
 * @module @deepseek-ai/dsh-code-review
 */

import { join, relative } from 'node:path'
import { runCommand } from './runner'
import { resolveBin, type Toolchain } from './languages'
import type { Finding, Severity } from './types'

/** Normalized static-check outcome. */
export interface LintOutcome {
  findings: Finding[]
  /** True when the linter ran to completion; false when the binary was missing. */
  ran: boolean
  /** Raw exit code. */
  exitCode: number | null
  /** Raw tool output tail, for the report appendix. */
  rawTail: string
  /** Reason when the tool could not run. */
  error?: string
}

/** Normalized format-check outcome. */
export interface FormatOutcome {
  /** True when all files are formatted (or the formatter passed). */
  clean: boolean
  ran: boolean
  exitCode: number | null
  /** Files reported as needing formatting. */
  dirtyFiles: string[]
  rawTail: string
  error?: string
}

const ESLINT_SEVERITY_TO_LEVEL: Record<number, Severity> = { 2: 'P1', 1: 'P2', 0: 'P3' }

/**
 * Run the toolchain's linter in `projectDir` and normalize its output.
 * ESLint (JSON) and tsc (text) parsers are wired; unknown tools fall back to
 * raw output with an explicit note so the report stays honest.
 * @param projectDir - project root.
 * @param toolchain - the matched toolchain.
 * @param tool - which linter variant to run (`lint` or `tsc`).
 * @returns normalized findings.
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

/** Run the formatter in check mode. */
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

/** Parse ESLint `--format json` output. */
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

/** Parse `tsc --noEmit` text output: `path(line,col): error TS1234: msg`. */
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

/** Parse `ruff check` text output: `path:line:col: code msg`. */
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

/** Heuristically extract files that need formatting from formatter output. */
export function extractDirtyFiles(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`
  const files: string[] = []
  // prettier --check: "path/file.ts" on its own line (non-formatted files are
  // listed; the rest is a summary line).
  const pattern = /^([^\s]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|json|css|scss|less|md|py|java|php))$/gm
  for (const match of combined.matchAll(pattern)) {
    const candidate = match[1] ?? ''
    if (!candidate.includes('All matched')) files.push(candidate)
  }
  return [...new Set(files)]
}

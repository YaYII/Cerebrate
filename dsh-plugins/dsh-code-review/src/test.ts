/**
 * Test-suite execution with summary normalization.
 *
 * Runs the toolchain's test command and extracts pass/fail/coverage numbers
 * from the runner's text output. Parsers are wired for vitest and pytest;
 * anything else falls back to exit-code granularity with an explicit note.
 * @module @deepseek-ai/dsh-code-review
 */

import { runCommand } from './runner'
import { resolveBin, type Toolchain } from './languages'
import type { TestResult } from './types'

/** Options for {@link runTests}. */
export interface TestOptions {
  cwd?: string
  timeoutMs?: number
  /** Extra CLI args appended to the test command, e.g. `--coverage`. */
  extraArgs?: string[]
}

/**
 * Run the toolchain's test suite.
 * @param projectDir - project root.
 * @param toolchain - the matched toolchain.
 * @param options - run options.
 * @returns normalized test result.
 */
export async function runTests(projectDir: string, toolchain: Toolchain, options: TestOptions = {}): Promise<TestResult> {
  const spec = toolchain.test
  if (!spec) {
    return { tool: toolchain.language, total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, error: `no test command for ${toolchain.language}` }
  }
  const args = [...spec.args, ...(options.extraArgs ?? [])]
  const bin = resolveBin(projectDir, spec.bin)
  const result = await runCommand(bin, args, {
    cwd: options.cwd ?? projectDir,
    timeoutMs: options.timeoutMs ?? 300_000,
  })

  const combined = `${result.stdout}\n${result.stderr}`
  const summary = parseTestSummary(toolchain, combined)

  if (summary) {
    return {
      tool: spec.bin,
      ...summary,
      durationMs: result.durationMs,
      ...(result.timedOut ? { error: `timed out after ${options.timeoutMs ?? 300_000}ms` } : {}),
    }
  }
  // Fallback: exit-code granularity only.
  const ok = result.exitCode === 0
  return {
    tool: spec.bin,
    total: ok ? 1 : 1,
    passed: ok ? 1 : 0,
    failed: ok ? 0 : 1,
    skipped: 0,
    durationMs: result.durationMs,
    error: `no test summary parser wired for ${spec.bin} — exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}; raw tail:\n${combined.slice(-800)}`,
  }
}

interface TestSummary {
  total: number
  passed: number
  failed: number
  skipped: number
  coveragePct?: number
}

/** Parse runner-specific summary lines into numbers. */
export function parseTestSummary(toolchain: Toolchain, combined: string): TestSummary | undefined {
  if (toolchain.language === 'js-ts') {
    // vitest: " Test Files  1 passed | 0 failed", " Tests  3 passed | 0 failed (5)".
    const tests = /Tests\s+(\d+)\s+passed\s*\|\s*(\d+)\s+failed(?:\s*\(\s*(\d+)\s*\))?/.exec(combined)
    if (tests) {
      const passed = Number(tests[1])
      const failed = Number(tests[2])
      const coveragePct = extractCoveragePct(combined)
      return {
        total: passed + failed,
        passed,
        failed,
        skipped: 0,
        ...(coveragePct !== undefined ? { coveragePct } : {}),
      }
    }
    // jest: "Tests: 3 passed, 3 total".
    const jest = /Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/.exec(combined)
    if (jest) {
      const coveragePct = extractCoveragePct(combined)
      return {
        total: Number(jest[3]),
        passed: Number(jest[2]),
        failed: Number(jest[1]),
        skipped: 0,
        ...(coveragePct !== undefined ? { coveragePct } : {}),
      }
    }
  }
  if (toolchain.language === 'python') {
    // pytest: "1 passed, 2 failed, 3 skipped in 1.23s" (any subset of parts).
    const pytest = /(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/.exec(combined)
    if (pytest && /pytest|passed/.test(combined)) {
      const passed = Number(pytest[1])
      const failed = Number(pytest[2] ?? 0)
      const skipped = Number(pytest[3] ?? 0)
      const coveragePct = extractCoveragePct(combined)
      return {
        total: passed + failed + skipped,
        passed,
        failed,
        skipped,
        ...(coveragePct !== undefined ? { coveragePct } : {}),
      }
    }
  }
  if (toolchain.language === 'php') {
    // PHPUnit: "OK (5 tests, 10 assertions)" / "FAILURES! Tests: 5, Assertions: 10, Failures: 2."
    const phpunitOk = /OK\s*\((\d+)\s+tests?/.exec(combined)
    if (phpunitOk) {
      return { total: Number(phpunitOk[1]), passed: Number(phpunitOk[1]), failed: 0, skipped: 0 }
    }
    const phpunitFail = /Tests:\s*(\d+)[^F]*Failures:\s*(\d+)/.exec(combined)
    if (phpunitFail) {
      const total = Number(phpunitFail[1])
      const failed = Number(phpunitFail[2])
      return { total, passed: total - failed, failed, skipped: 0 }
    }
  }
  return undefined
}

/** Extract a coverage percentage from common reporter outputs. */
export function extractCoveragePct(combined: string): number | undefined {
  // vitest coverage-v8 表格: "All files          |   68.73 |   58.92 |   71.84 |   69.89"
  const table = /All files\s*\|\s*([\d.]+)%?/.exec(combined)
  if (table) return Number(table[1])
  // vitest coverage-v8 旧格式: "All files  82.35%" / "% Coverage: 82.35".
  const allFiles = /All files\s+([\d.]+)%/.exec(combined)
  if (allFiles) return Number(allFiles[1])
  const coverage = /% Coverage[:\s]+([\d.]+)%?/.exec(combined)
  if (coverage) return Number(coverage[1])
  // pytest-cov: "TOTAL   82.35%".
  const total = /^TOTAL\s+[\d-]+\s+[\d-]+\s+([\d.]+)%/m.exec(combined)
  if (total) return Number(total[1])
  return undefined
}

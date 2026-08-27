/**
 * 测试套件执行与摘要归一化。
 *
 * 运行工具链的测试命令，并从运行器文本输出中提取通过/失败/覆盖率数字。
 * 已接入 vitest 与 pytest 解析器；其余工具回退为退出码粒度并附明确备注。
 * @module @deepseek-ai/dsh-code-review
 */

import { runCommand } from './runner'
import { resolveBin, type Toolchain } from './languages'
import type { TestResult } from './types'

/** {@link runTests} 的选项。 */
export interface TestOptions {
  cwd?: string
  timeoutMs?: number
  /** 追加到测试命令后的附加 CLI 参数，如 `--coverage`。 */
  extraArgs?: string[]
  /** 输出捕获上限（字节）。覆盖率表格可能很大，默认 64KB 会截断中间的摘要行——需调大。 */
  maxOutputBytes?: number
}

/**
 * 运行工具链的测试套件。
 * @param projectDir - 项目根目录。
 * @param toolchain - 匹配到的工具链。
 * @param options - 运行选项。
 * @returns 归一化的测试结果。
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
    // 覆盖率表格 + 文件列表 + 摘要行需要较大输出预算（默认 64KB 会截断中间的 Tests 行）
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : { maxOutputBytes: 512 * 1024 }),
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
  // 回退：仅退出码粒度。
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
  /** 解析告警：覆盖率未提取 / 摘要格式变化时的明确提示（绝不静默 undefined）。 */
  note?: string
}

/** 把运行器专属的摘要行解析为数字。 */
export function parseTestSummary(toolchain: Toolchain, combined: string): TestSummary | undefined {
  // 运行环境无 NO_COLOR 时（如 DSH 插件进程），vitest 会给摘要 token 逐段上色，
  // 色码（\x1b[32m 等）插在 "Tests" 与数字之间会破坏 "Tests N passed" 正则——
  // 解析前统一剥离 ANSI 转义序列，保证两种环境下解析结果一致。
  combined = combined.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
  if (toolchain.language === 'js-ts') {
    // vitest 全绿: "Tests  45 passed (45)"（无 failed 段）；有失败: "Tests  45 passed | 2 failed"。
    // failed 段可选：全绿时 failed=0；解析失败时返回带明确提示的 note，让 AI 能定位问题。
    const tests = /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\(\s*(\d+)\s*\))?/.exec(combined)
    if (tests) {
      const passed = Number(tests[1])
      const failed = tests[2] !== undefined ? Number(tests[2]) : 0
      const skipped = tests[3] !== undefined ? Number(tests[3]) : 0
      const coveragePct = extractCoveragePct(combined)
      return {
        total: passed + failed,
        passed,
        failed,
        skipped,
        ...(coveragePct !== undefined ? { coveragePct } : {}),
        ...(coveragePct === undefined ? { note: '覆盖率未提取：未在 vitest 输出中找到 "All files | xx%" 表格行（可能 --coverage 未生效或输出格式变更）' } : {}),
      }
    }
    // jest: "Tests: 3 passed, 3 total"（vitest 匹配失败时回退尝试）
    const jest = /Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/.exec(combined)
    if (jest) {
      const coveragePct = extractCoveragePct(combined)
      return {
        total: Number(jest[3]),
        passed: Number(jest[2]),
        failed: Number(jest[1]),
        skipped: 0,
        ...(coveragePct !== undefined ? { coveragePct } : {}),
        ...(coveragePct === undefined ? { note: '覆盖率未提取：未在 jest 输出中找到 "All files" 行' } : {}),
      }
    }
    // vitest/jest 输出格式均无法解析：明确提示原始输出尾部，绝不静默返回 undefined
    return {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      note: '测试摘要解析失败：输出中未找到 "Tests N passed"（vitest）或 "Tests: N passed"（jest）行（格式变更？），原始输出尾部：' + combined.slice(-300),
    }
  }
  if (toolchain.language === 'python') {
    // pytest: "1 passed, 2 failed, 3 skipped in 1.23s"（各组成部分可选）。
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
    // PHPUnit 成功格式："OK (5 tests, 10 assertions)"；失败格式："FAILURES! Tests: 5, Assertions: 10, Failures: 2."。
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

/** 从常见运行器输出中提取覆盖率百分比。 */
export function extractCoveragePct(combined: string): number | undefined {
  // vitest coverage-v8 表格: "All files          |   68.73 |   58.92 |   71.84 |   69.89"
  const table = /All files\s*\|\s*([\d.]+)%?/.exec(combined)
  if (table) return Number(table[1])
  // vitest coverage-v8 旧格式: "All files  82.35%" / "% Coverage: 82.35".
  const allFiles = /All files\s+([\d.]+)%/.exec(combined)
  if (allFiles) return Number(allFiles[1])
  const coverage = /% Coverage[:\s]+([\d.]+)%?/.exec(combined)
  if (coverage) return Number(coverage[1])
  // pytest-cov 汇总行："TOTAL   82.35%"（表尾 TOTAL 行的百分比）。
  const total = /^TOTAL\s+[\d-]+\s+[\d-]+\s+([\d.]+)%/m.exec(combined)
  if (total) return Number(total[1])
  return undefined
}

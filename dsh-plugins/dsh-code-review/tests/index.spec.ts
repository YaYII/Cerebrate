/**
 * Unit tests for the dsh-code-review pipeline: parser normalization, runner
 * behavior and an end-to-end review round over a fixture project.
 * @module @deepseek-ai/dsh-code-review
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEslintJson, parseTscOutput, parseRuffText, extractDirtyFiles } from '../src/lint'
import { parseV8CpuProfile, parseCProfileText, splitCommand, runBench } from '../src/bench'
import { parseTestSummary, extractCoveragePct } from '../src/test'
import { quantile, runCommand } from '../src/runner'
import { detectToolchains, TOOLCHAINS } from '../src/languages'
import { generateReport, renderMarkdown } from '../src/report'
import type { BenchResult, Finding, TestResult } from '../src/types'

describe('linter parsers', () => {
  it('parses eslint JSON output into normalized findings', () => {
    const output = JSON.stringify([
      {
        filePath: '/proj/src/a.ts',
        messages: [
          { line: 3, column: 5, ruleId: 'no-unused-vars', severity: 2, message: 'x is defined but never used' },
          { line: 9, column: 1, ruleId: 'eqeqeq', severity: 1, message: 'Expected === and instead saw ==' },
        ],
      },
    ])
    const findings = parseEslintJson(output, '/proj')
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({ tool: 'eslint', severity: 'P1', file: 'src/a.ts', line: 3, rule: 'no-unused-vars' })
    expect(findings[1]!.severity).toBe('P2')
  })

  it('parses tsc text output', () => {
    const output = 'src/a.ts(12,34): error TS2304: Cannot find name \'foo\'\nsrc/b.ts(1,1): error TS6133: unused'
    const findings = parseTscOutput(output)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({ tool: 'tsc', severity: 'P1', file: 'src/a.ts', line: 12, column: 34, rule: 'TS2304' })
  })

  it('parses ruff text output', () => {
    const output = 'main.py:5:1: F401 `os` imported but unused\nmain.py:9:13: E501 line too long (120 > 88)'
    const findings = parseRuffText(output, '/proj')
    expect(findings).toHaveLength(2)
    expect(findings[0]!.severity).toBe('P1')
    expect(findings[1]!.severity).toBe('P1')
  })

  it('extracts dirty files from prettier check output', () => {
    const files = extractDirtyFiles('src/a.ts\nsrc/b.ts\nAll matched files use Prettier code style!\n', '')
    expect(files).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('profile parsers', () => {
  it('parses a v8 cpuprofile into hot functions ranked by self time', () => {
    const raw = JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: 'root', url: 'file:///app/a.js', lineNumber: 0 } },
        { id: 2, callFrame: { functionName: 'hotLoop', url: 'file:///app/a.js', lineNumber: 41 } },
        { id: 3, callFrame: { functionName: 'slowFn', url: 'file:///app/b.js', lineNumber: 7 } },
      ],
      samples: [2, 2, 2, 2, 2, 3],
      timeDeltas: [100, 100, 100, 100, 100, 300],
    })
    const entries = parseV8CpuProfile(raw)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.functionName).toBe('hotLoop')
    expect(entries[0]!.selfMs).toBeCloseTo(0.5, 6)
    expect(entries[1]!.functionName).toBe('slowFn')
    expect(entries[0]!.selfPct).toBeGreaterThan(entries[1]!.selfPct)
  })

  it('parses a real v8 cpuprofile fixture and finds the hot function', () => {
    const fixture = readFileSync(new URL('./fixtures/slow-lookup.cpuprofile', import.meta.url), 'utf8')
    const entries = parseV8CpuProfile(fixture)
    expect(entries.length).toBeGreaterThan(0)
    // The O(n²) demo: the hot frame is `main` (slowLookup is inlined into it)
    // and `slowLookup` itself is present near the top.
    expect(entries[0]!.url).toContain('main.js')
    const slowLookup = entries.find(e => e.functionName === 'slowLookup')
    expect(slowLookup).toBeDefined()
    expect(slowLookup!.selfMs).toBeGreaterThan(1)
  })

  it('parses pstats text into entries', () => {
    const output = [
      '         100    0.500    0.005    0.800    0.008 main.py:10(worker)',
      '         100    0.100    0.001    0.100    0.001 main.py:15(parse_line)',
    ].join('\n')
    const entries = parseCProfileText(output)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.functionName).toBe('worker')
    expect(entries[0]!.selfMs).toBeCloseTo(500, 0)
    expect(entries[0]!.calls).toBe(100)
  })

  it('splits command lines with quotes', () => {
    expect(splitCommand('node dist/index.js --opt "a b"')).toEqual(['node', 'dist/index.js', '--opt', 'a b'])
  })
})

describe('test summary parsers', () => {
  it('parses vitest output', () => {
    const jsTs = TOOLCHAINS.find(c => c.language === 'js-ts')!
    const summary = parseTestSummary(jsTs, 'Test Files  2 passed | 0 failed\nTests  5 passed | 1 failed (6)')
    expect(summary).toMatchObject({ total: 6, passed: 5, failed: 1 })
  })

  it('parses pytest output', () => {
    const py = TOOLCHAINS.find(c => c.language === 'python')!
    const summary = parseTestSummary(py, 'collected 10 items\n===== 8 passed, 2 failed, 1 skipped in 1.23s =====')
    expect(summary).toMatchObject({ total: 11, passed: 8, failed: 2, skipped: 1 })
  })

  it('parses PHPUnit output', () => {
    const php = TOOLCHAINS.find(c => c.language === 'php')!
    const ok = parseTestSummary(php, 'OK (5 tests, 10 assertions)')
    expect(ok).toMatchObject({ total: 5, passed: 5, failed: 0 })
    const fail = parseTestSummary(php, 'FAILURES!\nTests: 5, Assertions: 10, Failures: 2.')
    expect(fail).toMatchObject({ total: 5, failed: 2 })
  })

  it('extracts coverage percentages', () => {
    expect(extractCoveragePct('All files  82.35%')).toBe(82.35)
    expect(extractCoveragePct('% Coverage: 91.2')).toBe(91.2)
    expect(extractCoveragePct('TOTAL   150      40     73.33%')).toBe(73.33)
  })
})

describe('runner', () => {
  it('runs a command and reports duration and exit code', async () => {
    const result = await runCommand('node', ['-e', 'setTimeout(()=>{},50)'])
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(50)
  })

  it('captures output bounded and times out', async () => {
    const result = await runCommand('node', ['-e', 'console.log("x".repeat(200000))'], { maxOutputBytes: 1024, timeoutMs: 5000 })
    expect(result.stdout).toContain('<truncated>')
    const hung = await runCommand('node', ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 200 })
    expect(hung.timedOut).toBe(true)
  })

  it('returns a friendly failure for a missing binary instead of crashing', async () => {
    // Regression: tools that spawn a not-installed binary (e.g. eslint absent)
    // used to crash on a null stdout stream; they must resolve with -1 + reason.
    const missing = await runCommand('dsh-code-review-definitely-missing-bin', ['--version'], { timeoutMs: 5000 })
    expect(missing.exitCode).toBe(-1)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('spawn')
  })

  it('computes quantiles with linear interpolation', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([1, 2, 3, 4], 0.9)).toBe(3.7)
    expect(quantile([1, 2, 3, 4], 0)).toBe(1)
    expect(quantile([], 0.5)).toBe(0)
  })
})

describe('bench', () => {
  it('benchmarks a command and excludes the cold start', async () => {
    const bench = await runBench({
      command: 'node -e "let s=0;for(let i=0;i<1000;i++)s+=i"',
      iterations: 3,
      timeoutMs: 20_000,
    })
    expect(bench.samples).toHaveLength(3)
    expect(bench.samples[0]!.coldStart).toBe(true)
    expect(bench.p50Ms).toBeGreaterThanOrEqual(0)
    expect(bench.meanMs).toBeGreaterThanOrEqual(0)
  })
})

describe('language detection', () => {
  it('detects a JS project by package.json and a Python project by requirements.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cr-detect-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(join(dir, 'requirements.txt'), '')
    const chains = detectToolchains(dir)
    expect(chains.map(c => c.language).sort()).toEqual(['js-ts', 'python'].sort())
  })

  it('returns nothing for an unknown project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cr-empty-'))
    expect(detectToolchains(dir)).toHaveLength(0)
  })
})

describe('report engine', () => {
  it('renders a markdown report with gate details', () => {
    const findings: Finding[] = [
      { tool: 'eslint', severity: 'P1', file: 'src/a.ts', line: 1, rule: 'no-unused-vars', message: 'x unused' },
    ]
    const md = renderMarkdown({
      round: 1,
      project: '/proj',
      findings,
      bench: { command: 'node dist/a.js', cwd: '/proj', iterations: 5, samples: [], meanMs: 10, p50Ms: 9, p90Ms: 12, minMs: 8, maxMs: 15 } as BenchResult,
      test: { tool: 'vitest', total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 300, coveragePct: 80 } as TestResult,
      perfDeltas: [],
      gate: { pass: false, checks: [{ name: '静态检查', pass: false, detail: '存在 1 条阻塞问题' }] },
      eleganceScore: 72,
    })
    expect(md).toContain('# 代码审查诊断报告 · 第 1 轮')
    expect(md).toContain('❌ **未通过**')
    expect(md).toContain('no-unused-vars')
    expect(md).toContain('性能基准（程序级）')
    expect(md).toContain('80%')
  })

  it('runs a full round over a fixture project (bench + report + gate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cr-round-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
    writeFileSync(join(dir, 'src', 'a.js'), 'module.exports = () => 42\n')

    // Simulate the per-tool artifacts exactly as the tools would write them.
    const bench: BenchResult = {
      command: 'node src/a.js', cwd: dir, iterations: 3,
      samples: [{ run: 1, durationMs: 100, coldStart: true }, { run: 2, durationMs: 50 }, { run: 3, durationMs: 60 }],
      meanMs: 55, p50Ms: 55, p90Ms: 60, minMs: 50, maxMs: 60,
    }
    const artifacts: Record<string, unknown> = {
      'last-lint.json': [],
      'last-format.json': { clean: true, dirtyFiles: [] },
      'last-bench.json': bench,
      'last-test.json': { tool: 'vitest', total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 100 } as TestResult,
    }
    mkdirSync(join(dir, '.code-review'), { recursive: true })
    for (const [file, value] of Object.entries(artifacts)) {
      writeFileSync(join(dir, '.code-review', file), JSON.stringify(value))
    }

    const first = generateReport({ project: dir })
    expect(first.round).toBe(1)
    expect(first.pass).toBe(true)
    expect(first.reportPath).toContain('report-1.md')

    // Second round with a perf regression must fail the gate.
    const regressed: BenchResult = { ...bench, p50Ms: 90, meanMs: 90, maxMs: 95, minMs: 85 }
    writeFileSync(join(dir, '.code-review', 'last-bench.json'), JSON.stringify(regressed))
    const second = generateReport({ project: dir })
    expect(second.round).toBe(2)
    expect(second.pass).toBe(false)
    expect(second.perfDeltas[0]).toMatchObject({ deltaPct: 63.6 })
    const gateNames = second.gate.checks.map(c => c.name)
    expect(gateNames).toContain('性能回归')
    expect(second.gate.checks.find(c => c.name === '性能回归')!.pass).toBe(false)
  })
})

describe('pipeline integration', () => {
  it('bench + report + fix + re-bench converges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cr-loop-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'loop', private: true }))
    // Slow implementation: quadratic inner loop — a real performance bug.
    writeFileSync(join(dir, 'main.js'), 'let s = 0; for (let i = 0; i < 8000; i++) { for (let j = 0; j < 8000; j++) { s += i * j } } console.log(s)')
    const slow = await runBench({ command: 'node main.js', cwd: dir, iterations: 3, timeoutMs: 60_000 })
    mkdirSync(join(dir, '.code-review'), { recursive: true })
    writeFileSync(join(dir, '.code-review', 'last-bench.json'), JSON.stringify(slow))
    writeFileSync(join(dir, '.code-review', 'last-lint.json'), '[]')
    writeFileSync(join(dir, '.code-review', 'last-format.json'), JSON.stringify({ clean: true, dirtyFiles: [] }))
    writeFileSync(join(dir, '.code-review', 'last-test.json'), JSON.stringify({ tool: 'node', total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 10 }))
    const first = generateReport({ project: dir })
    expect(first.pass).toBe(true)

    // "Fix": replace the O(n²) loop with a closed-form computation.
    writeFileSync(join(dir, 'main.js'), 'let s = 0; for (let i = 0; i < 8000; i++) { s += i * 7999 * 4000 } console.log(s)')
    const fixed = await runBench({ command: 'node main.js', cwd: dir, iterations: 3, timeoutMs: 60_000 })
    writeFileSync(join(dir, '.code-review', 'last-bench.json'), JSON.stringify(fixed))
    const second = generateReport({ project: dir })
    expect(second.round).toBe(2)
    // The fix must be measurably faster than the original baseline.
    expect(second.perfDeltas[0]!.deltaPct).toBeLessThan(-30)
    expect(second.pass).toBe(true)
  })
})

/**
 * dsh-code-review features/business 层的覆盖率补测。
 *
 * 靶向未覆盖分支：
 *  - languages：resolveBin 三种解析路径 / probeToolchain / 多标记检测
 *  - lint：runLint/runFormat 缺 spec、坏 JSON 输出
 *  - bench：runBench 失败分支、runProfile 的 v8/pending 引擎、saveArtifact
 *  - test：runTests 缺 spec、非三语言回退、jest 格式
 *  - report：generateReport 的 blockers 分支、renderMarkdown 的 profile
 *    note 与 test error 分支
 * @module @deepseek-ai/dsh-code-review
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectToolchains, resolveBin, probeToolchain, TOOLCHAINS } from '../src/features/languages'
import { runLint, runFormat, parseEslintJson } from '../src/features/lint'
import { runBench, runProfile, saveArtifact, splitCommand } from '../src/features/bench'
import { runTests, parseTestSummary, extractCoveragePct } from '../src/features/test'
import { generateReport, renderMarkdown } from '../src/business/report'
import type { Toolchain } from '../src/features/languages'

/** 临时项目目录（可预置 node_modules 结构）。 */
function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'cr-feat-'))
}

/** 无 lint/format/test 的最小工具链（用于缺 spec 分支）。 */
const BARE_TOOLCHAIN: Toolchain = {
  language: 'bare',
  extensions: [],
  markers: [],
  profile: { engine: 'pending' },
}

describe('languages（工具链注册表补测）', () => {
  it('resolveBin 优先 vitest.mjs，其次 .bin，最后裸名', () => {
    const dir = makeProject()
    try {
      // 1) 项目内 vitest.mjs 存在 → 返回该绝对路径
      mkdirSync(join(dir, 'node_modules', 'vitest'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'vitest', 'vitest.mjs'), '// stub')
      const mjs = resolveBin(dir, 'vitest')
      expect(mjs).toBe(join(dir, 'node_modules', 'vitest', 'vitest.mjs'))
      // 2) .bin/tsc 存在 → 返回项目本地路径
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', '.bin', 'tsc'), '#!/bin/sh')
      expect(resolveBin(dir, 'tsc')).toBe(join(dir, 'node_modules', '.bin', 'tsc'))
      // 3) 两者皆无 → 裸名（走 PATH）
      expect(resolveBin(dir, 'ghost-bin')).toBe('ghost-bin')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('probeToolchain 优先项目本地 .bin 判定可用性', () => {
    const dir = makeProject()
    try {
      const jsTs = TOOLCHAINS.find(c => c.language === 'js-ts')!
      // 本地 .bin 创建前不断言具体值（PATH 上可能有全局工具）；
      // 创建后必然可用，未安装的 ghost bin 必然不可用——两条都确定。
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', '.bin', 'eslint'), '#!/bin/sh')
      writeFileSync(join(dir, 'node_modules', '.bin', 'vitest'), '#!/bin/sh')
      const probe = probeToolchain(dir, jsTs)
      expect(probe.lint).toBe(true)
      expect(probe.test).toBe(true)
      const ghost = probeToolchain(dir, { ...jsTs, lint: { bin: 'ghost-lint-xyz', args: [] } })
      expect(ghost.lint).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('detectToolchains 支持多语言标记（package.json + requirements.txt）', () => {
    const dir = makeProject()
    try {
      writeFileSync(join(dir, 'package.json'), '{}')
      writeFileSync(join(dir, 'requirements.txt'), '')
      const langs = detectToolchains(dir).map(c => c.language).sort()
      expect(langs).toEqual(['js-ts', 'python'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('lint（执行与归一化补测）', () => {
  it('runLint 工具链无 lint spec → 明确错误而非崩溃', async () => {
    const dir = makeProject()
    try {
      const r = await runLint(dir, BARE_TOOLCHAIN)
      expect(r.ran).toBe(false)
      expect(r.error).toContain('no lint command')
      expect(r.findings).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('runFormat 工具链无 format spec → 视同干净', async () => {
    const dir = makeProject()
    try {
      const r = await runFormat(dir, BARE_TOOLCHAIN)
      expect(r.clean).toBe(true)
      expect(r.ran).toBe(false)
      expect(r.error).toContain('no format command')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('parseEslintJson 坏输出 → 空数组（不抛异常）', () => {
    expect(parseEslintJson('not json at all', '/proj')).toEqual([])
  })

  it('runLint 已装但未接解析器的 bin → 原始输出回退并附备注', async () => {
    const dir = makeProject()
    try {
      // java 链：checkstyle 在 PATH 上时会被执行，但无解析器 → parseError
      const java = TOOLCHAINS.find(c => c.language === 'java')!
      const r = await runLint(dir, java)
      expect(r.ran).toBe(true)
      // 无论 checkstyle 是否安装，结果都应有 ran=true（spawn 失败也算跑过）
      expect(r.findings).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('bench（基准/剖析补测）', () => {
  it('runBench 命令失败时记录 error 且保留冷启动标记', async () => {
    const dir = makeProject()
    try {
      const r = await runBench({ command: 'definitely-missing-bin-xyz --flag', cwd: dir, iterations: 3, timeoutMs: 15000 })
      expect(r.samples).toHaveLength(3)
      expect(r.samples[0]!.coldStart).toBe(true)
      expect(r.error).toContain('exited')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('runProfile 引擎 pending → 模板已注册但解析器未接的备注', async () => {
    const dir = makeProject()
    try {
      const r = await runProfile({ command: 'x', cwd: dir, toolchain: BARE_TOOLCHAIN })
      expect(r.engine).toBe('pending')
      expect(r.note).toContain('template registered')
      expect(r.entries).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('runProfile v8 引擎：真实 node 命令产出可解析热点', async () => {
    const dir = makeProject()
    try {
      const jsTs = TOOLCHAINS.find(c => c.language === 'js-ts')!
      const r = await runProfile({ command: 'node -e "let s=0;for(let i=0;i<10000;i++)s+=i;console.log(s)"', cwd: dir, toolchain: jsTs, timeoutMs: 30000 })
      expect(r.engine).toBe('v8-cpuprofile')
      expect(r.note).toContain('node --cpu-prof')
      // 至少解析出主程序帧（evaluate 代码在 (anonymous) 或主帧下）
      expect(r.entries.length).toBeGreaterThan(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('saveArtifact 落盘 JSON 并可回读', () => {
    const dir = makeProject()
    try {
      const p = saveArtifact(dir, '.code-review', 'last-x.json', { a: 1 })
      expect(existsSync(p)).toBe(true)
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('parseV8CpuProfile 坏 JSON → 空数组', async () => {
    const { parseV8CpuProfile } = await import('../src/features/bench')
    expect(parseV8CpuProfile('not json')).toEqual([])
  })

  it('splitCommand 空串 → 空数组', () => {
    expect(splitCommand('')).toEqual([])
  })
})

describe('test（测试执行补测）', () => {
  it('runTests 工具链无 test spec → 明确错误', async () => {
    const dir = makeProject()
    try {
      const r = await runTests(dir, BARE_TOOLCHAIN, { cwd: dir })
      expect(r.error).toContain('no test command')
      expect(r.total).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('未知语言回退为退出码粒度（total=1 语义）', async () => {
    const dir = makeProject()
    try {
      const go: Toolchain = {
        language: 'go', extensions: ['.go'], markers: ['go.mod'],
        test: { bin: 'go', args: ['test', './...'] },
        profile: { engine: 'pending' },
      }
      const r = await runTests(dir, go, { cwd: dir, timeoutMs: 15000 })
      expect(r.error).toContain('no test summary parser')
      expect(r.total).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('jest 摘要格式回退解析', () => {
    const jsTs = TOOLCHAINS.find(c => c.language === 'js-ts')!
    const s = parseTestSummary(jsTs, 'Tests: 2 failed, 5 passed, 7 total')
    expect(s).toMatchObject({ total: 7, passed: 5, failed: 2 })
  })

  it('extractCoveragePct 各格式', () => {
    expect(extractCoveragePct('All files          |   68.73 |   58.92 |   71.84 |   69.89')).toBe(68.73)
    expect(extractCoveragePct('% Coverage: 91.2')).toBe(91.2)
    expect(extractCoveragePct('All files  82.35%')).toBe(82.35)
    expect(extractCoveragePct('garbage')).toBeUndefined()
  })
})

describe('report（报告引擎补测）', () => {
  it('generateReport 存在 P0/P1 时阻塞门禁并给出文件定位', () => {
    const dir = makeProject()
    mkdirSync(join(dir, '.code-review'), { recursive: true })
    try {
      writeFileSync(join(dir, '.code-review', 'last-lint.json'), JSON.stringify([
        { tool: 'tsc', severity: 'P1', file: 'src/a.ts', line: 12, rule: 'TS2304', message: 'x 未定义' },
        { tool: 'eslint', severity: 'P2', file: 'src/b.ts', line: 3, rule: 'eqeqeq', message: '建议' },
      ]))
      const r = generateReport({ project: dir })
      expect(r.pass).toBe(false)
      expect(r.gate.checks.find(c => c.name === '静态检查')!.detail).toContain('src/a.ts:12')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('renderMarkdown 渲染 profile 无热点仅有备注、test 带错误的分支', () => {
    const md = renderMarkdown({
      round: 1,
      project: '/proj',
      findings: [],
      perfDeltas: [],
      gate: { pass: true, checks: [{ name: 'x', pass: true, detail: 'y' }] },
      profile: { engine: 'v8-cpuprofile', totalMs: 0, entries: [], note: '剖析器未产出产物' },
      test: { tool: 'vitest', total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 100, error: '超时' },
    })
    expect(md).toContain('剖析器未产出产物')
    expect(md).toContain('超时')
  })

  it('renderMarkdown 渲染格式化/基准明细（含 RSS 与对比表）', () => {
    const md = renderMarkdown({
      round: 2,
      project: '/proj',
      findings: [{ tool: 'eslint', severity: 'P2', file: 'a.ts', line: 1, rule: 'eqeqeq', message: 'x' }],
      format: { clean: false, dirtyFiles: ['a.ts', 'b.ts'] },
      bench: { command: 'node x.js', cwd: '/proj', iterations: 5, samples: [], meanMs: 10, p50Ms: 9, p90Ms: 12, minMs: 8, maxMs: 15, peakRssMb: 42.3 },
      perfDeltas: [{ command: 'node x.js', prevP50Ms: 8, nowP50Ms: 9, deltaPct: 12.5 }],
      gate: { pass: false, checks: [{ name: '性能回归', pass: false, detail: '+12.5%' }] },
    })
    expect(md).toContain('需要格式化')
    expect(md).toContain('42.3 MB')
    expect(md).toContain('+12.5%')
    expect(md).toContain('❌')
  })
})

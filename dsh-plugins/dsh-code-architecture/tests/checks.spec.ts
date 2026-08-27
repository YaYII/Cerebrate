import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runArchChecks, collectSourceFiles, checkCommentLanguage, checkNaming, checkSeparation, checkDependencyDirection } from '../src/features/checks'

/** 构造临时项目。 */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'))
  mkdirSync(join(dir, 'src', 'utils'), { recursive: true })
  mkdirSync(join(dir, 'src', 'services'), { recursive: true })
  writeFileSync(join(dir, 'src', 'utils', 'helper.ts'), [
    '/** 字符串工具——功能砖块，不绑业务。 */',
    'export function padLeft(x: string, n: number): string {',
    '  return x.padStart(n, \'0\')',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'src', 'services', 'order.ts'), [
    '/** 订单服务——业务组合层。 */',
    'import { padLeft } from \'../utils/helper\'',
    'export function createOrderNo(): string {',
    '  return padLeft(\'42\', 8)',
    '}',
    '',
  ].join('\n'))
  return dir
}

describe('架构自检规则', () => {
  it('checkCommentLanguage 检出英文注释', () => {
    const dir = makeProject()
    try {
      writeFileSync(join(dir, 'src', 'utils', 'bad.ts'), [
        '/** This is an English comment. */',
        'export const x = 1',
      ].join('\n'))
      const findings = checkCommentLanguage(join(dir, 'src', 'utils', 'bad.ts'), 'src/utils/bad.ts')
      expect(findings.some(f => f.rule === 'C1')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('中文注释夹带英文技术词不误报（回归：dirty-file/path/error 等触发 \bfile\b 命中）', () => {
    const dir = makeProject()
    try {
      writeFileSync(join(dir, 'src', 'utils', 'ok.ts'), [
        '/**',
        ' * 解析 tsc --noEmit 文本输出：path(line,col): error TS1234: msg。',
        ' * 在等待捕获之前注册退出码监听：失败的 spawn（ENOENT）会提前触发 error。',
        ' * 落盘 dirty-file 清单。',
        ' */',
        'export const y = 2',
      ].join('\n'))
      const findings = checkCommentLanguage(join(dir, 'src', 'utils', 'ok.ts'), 'src/utils/ok.ts')
      expect(findings.some(f => f.rule === 'C1')).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('checkNaming 检出小驼峰违规', () => {
    const dir = makeProject()
    try {
      writeFileSync(join(dir, 'src', 'utils', 'naming.ts'), [
        'export function Bad_Name(x: number) { return x }',
      ].join('\n'))
      const findings = checkNaming(join(dir, 'src', 'utils', 'naming.ts'), 'src/utils/naming.ts')
      expect(findings.some(f => f.rule === 'N1')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('checkSeparation 检出功能层业务词汇', () => {
    const dir = makeProject()
    try {
      writeFileSync(join(dir, 'src', 'utils', 'biz.ts'), [
        '/** 工具 */',
        'export function processOrder() { return 1 }',
      ].join('\n'))
      const findings = checkSeparation(join(dir, 'src', 'utils', 'biz.ts'), 'src/utils/biz.ts')
      expect(findings.some(f => f.rule === 'S1')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('checkDependencyDirection 检出功能层依赖业务层', () => {
    const dir = makeProject()
    try {
      writeFileSync(join(dir, 'src', 'utils', 'leak.ts'), [
        '/** 工具 */',
        "import { createOrderNo } from '../services/order'",
        'export function x() { return createOrderNo() }',
      ].join('\n'))
      const findings = checkDependencyDirection(join(dir, 'src', 'utils', 'leak.ts'), 'src/utils/leak.ts')
      expect(findings.some(f => f.rule === 'E1')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('runArchChecks 聚合报告', () => {
    const dir = makeProject()
    try {
      const report = runArchChecks(dir)
      expect(report.stats.files).toBeGreaterThan(0)
      expect(Array.isArray(report.findings)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

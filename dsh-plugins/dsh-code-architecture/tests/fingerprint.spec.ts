import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fingerprintProject, diffFingerprints } from '../src/fingerprint'

/** 构造分层项目。 */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fp-'))
  mkdirSync(join(dir, 'src', 'utils'), { recursive: true })
  mkdirSync(join(dir, 'src', 'services'), { recursive: true })
  writeFileSync(join(dir, 'src', 'utils', 'helper.ts'), [
    '/** 工具 */',
    'export function pad(s: string): string { return s }',
  ].join('\n'))
  writeFileSync(join(dir, 'src', 'services', 'order.ts'), [
    '/** 业务 */',
    "import { pad } from '../utils/helper'",
    'export function createNo(): string { return pad(\'1\') }',
  ].join('\n'))
  return dir
}

describe('架构指纹（防漂移锚点）', () => {
  it('生成指纹：识别分层与依赖方向', () => {
    const dir = makeProject()
    try {
      const fp = fingerprintProject(dir)
      expect(fp.featureFiles).toContain('src/utils/helper.ts')
      expect(fp.businessFiles).toContain('src/services/order.ts')
      expect(fp.dependencyViolations.length).toBe(0) // 业务依赖功能，合法
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('检出依赖倒转（功能层 import 业务层）', () => {
    const dir = makeProject()
    try {
      writeFileSync(join(dir, 'src', 'utils', 'leak.ts'), [
        '/** 工具 */',
        "import { createNo } from '../services/order'",
        'export function x() { return createNo() }',
      ].join('\n'))
      const fp = fingerprintProject(dir)
      expect(fp.dependencyViolations.length).toBe(1)
      expect(fp.dependencyViolations[0]!.file).toBe('src/utils/leak.ts')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('对比指纹：检出新增/修改/删除/分层迁移', () => {
    const dir = makeProject()
    try {
      const base = fingerprintProject(dir)
      // 新增 + 修改 + 删除
      writeFileSync(join(dir, 'src', 'utils', 'helper.ts'), 'export function pad(s: string): string { return s + s }')
      writeFileSync(join(dir, 'src', 'utils', 'new.ts'), '/** 新 */\nexport const y = 1')
      rmSync(join(dir, 'src', 'services', 'order.ts'))
      const cur = fingerprintProject(dir)
      const diff = diffFingerprints(base, cur)
      expect(diff.drifted).toBe(true)
      expect(diff.added).toContain('src/utils/new.ts')
      expect(diff.modified).toContain('src/utils/helper.ts')
      expect(diff.deleted).toContain('src/services/order.ts')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

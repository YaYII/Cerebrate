/**
 * Locale integrity: zh and en dictionaries carry exactly the same keys, so a
 * settings row can never render a missing translation.
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('Apple Glass skin locales', () => {
  it('expose identical key sets in zh and en', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('cover every choice the row renders', () => {
    const keys = Object.keys(zh)
    for (const key of ['skin.title', 'skin.default', 'skin.defaultDesc', 'skin.light', 'skin.lightDesc', 'skin.dark', 'skin.darkDesc']) {
      expect(keys).toContain(key)
    }
  })

  it('keep non-empty translations', () => {
    for (const value of [...Object.values(zh), ...Object.values(en)]) {
      expect(value.trim().length).toBeGreaterThan(0)
    }
  })
})
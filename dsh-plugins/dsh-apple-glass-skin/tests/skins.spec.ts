/**
 * Skin catalog invariants: every theme must be registrable by ThemeRuntime
 * (id ≠ `system`, unique ids, explicit colorScheme) and must carry the
 * surface/label/state tokens the web shell actually consumes, so a skin can
 * never leave the UI illegible or partially tinted.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SKIN, findSkin, SKINS } from '../src/client/skins.ts'

/** Tokens every skin must override to stay readable on both palettes. */
const REQUIRED_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-brand-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
] as const

describe('Tech-Space skin catalog', () => {
  it('registers three skins: one light, two dark, unique namespaced ids', () => {
    expect(SKINS).toHaveLength(3)
    const ids = SKINS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['tech-space', 'tech-space-light', 'tech-matrix'])
    expect(SKINS.map(s => s.colorScheme).sort()).toEqual(['dark', 'dark', 'light'])
  })

  it('lists the deep-space dark skin first (the default boot skin)', () => {
    expect(SKINS[0]!.id).toBe('tech-space')
    expect(SKINS[0]!.colorScheme).toBe('dark')
  })

  it('never collides with the reserved `system` preference', () => {
    for (const skin of SKINS) expect(skin.id).not.toBe('system')
  })

  it('carries every required surface, label, and state token', () => {
    for (const skin of SKINS) {
      for (const token of REQUIRED_TOKENS) {
        expect(skin.tokens[token], `${skin.id} missing ${token}`).toBeTruthy()
      }
    }
  })

  it('uses concrete colors (no var() indirection) so contrast is self-contained', () => {
    for (const skin of SKINS) {
      for (const value of Object.values(skin.tokens)) {
        expect(value).not.toContain('var(')
      }
    }
  })

  it('gives every skin a backdrop gradient', () => {
    for (const skin of SKINS) {
      expect(skin.backdrop).toMatch(/^linear-gradient\(/)
    }
  })

  it('declares all three scene themes with a complete palette', () => {
    for (const skin of SKINS) {
      expect(skin.motion.scene).toMatch(/^(space|city|ocean|matrix)$/)
      for (const scene of ['space', 'city', 'ocean', 'matrix'] as const) {
        const cfg = skin.motion.scenes[scene]
        expect(cfg.base).toHaveLength(2)
        expect(cfg.accent).toBeTruthy()
        expect(cfg.accent2).toBeTruthy()
        expect(cfg.particle).toBeTruthy()
        expect(cfg.particleDensity).toBeGreaterThan(0)
        expect(cfg.speed).toBeGreaterThan(0)
      }
    }
  })

  it('covers the specific namespace tokens the shell consumes (sidebar etc.)', () => {
    const specific = [
      '--dsw-specific-sidebar-fill',
      '--dsw-specific-sidebar-nav-item-active',
      '--dsw-specific-sidebar-nav-item-hover',
      '--dsw-specific-tip',
      '--dsw-specific-menu',
    ]
    for (const skin of SKINS) {
      for (const token of specific) {
        expect(skin.tokens[token], `${skin.id} missing ${token}`).toBeTruthy()
      }
    }
  })

  it('findSkin resolves registered ids and rejects unknown ones', () => {
    expect(findSkin('tech-space')?.colorScheme).toBe('dark')
    expect(findSkin('tech-space-light')?.colorScheme).toBe('light')
    expect(findSkin('nope')).toBeUndefined()
  })

  it('DEFAULT_SKIN is the system follow sentinel', () => {
    expect(DEFAULT_SKIN).toBe('system')
  })
})

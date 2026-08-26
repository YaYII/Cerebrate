// @vitest-environment jsdom
/**
 * Backdrop layer DOM behavior: mounts once, updates the gradient in place,
 * removes cleanly, and stays inert (no pointer events, fixed, behind the app).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyBackdrop, BACKDROP_ID, hasBackdrop, removeBackdrop } from '../src/client/backdrop.ts'
import { SKINS } from '../src/client/skins.ts'

describe('Apple Glass backdrop layer', () => {
  beforeEach(() => {
    removeBackdrop()
  })

  it('mounts a fixed inert layer behind the app', () => {
    applyBackdrop(SKINS[0]!)
    const el = document.getElementById(BACKDROP_ID)
    expect(el).not.toBeNull()
    expect(el!.style.position).toBe('fixed')
    expect(el!.style.zIndex).toBe('-1')
    expect(el!.style.pointerEvents).toBe('none')
    expect(el!.getAttribute('aria-hidden')).toBe('true')
    expect(hasBackdrop()).toBe(true)
  })

  it('applies the skin gradient', () => {
    applyBackdrop(SKINS[0]!)
    expect(document.getElementById(BACKDROP_ID)!.style.background).toMatch(/^linear-gradient\(/)
  })

  it('updates the same element when the active skin changes', () => {
    applyBackdrop(SKINS[0]!)
    const first = document.getElementById(BACKDROP_ID)
    const firstValue = first!.style.background
    applyBackdrop(SKINS[1]!)
    const second = document.getElementById(BACKDROP_ID)
    expect(second).toBe(first)
    expect(second!.style.background).not.toBe(firstValue)
  })

  it('removes cleanly and reports absence', () => {
    applyBackdrop(SKINS[0]!)
    removeBackdrop()
    expect(document.getElementById(BACKDROP_ID)).toBeNull()
    expect(hasBackdrop()).toBe(false)
  })

  it('raises the canvas layer and isolates the app root', () => {
    // A canvas with a 2d context triggers the layer-stack management.
    document.body.innerHTML = '<div id="root"></div>'
    applyBackdrop(SKINS[0]!)
    const root = document.getElementById('root')
    expect(root!.style.isolation).toBe('isolate')
    expect(root!.style.zIndex).toBe('1')
    removeBackdrop()
    expect(root!.style.isolation).toBe('')
    expect(root!.style.zIndex).toBe('')
  })

  it('removing an absent layer is a no-op', () => {
    expect(() => removeBackdrop()).not.toThrow()
  })
})
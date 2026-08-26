// @vitest-environment jsdom
/**
 * Animated Canvas backdrop: when a 2d context is available the plugin mounts
 * the Canvas layer and keeps it in sync with the active skin; dispose tears
 * it down completely. (The jsdom default — no 2d context — exercises the
 * static-gradient fallback path, covered by backdrop.spec.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyBackdrop, hasBackdrop, isAnimatedBackdrop, removeBackdrop } from '../src/client/backdrop.ts'
import { SKINS } from '../src/client/skins.ts'

/** Minimal no-op 2d context satisfying every draw call the renderer makes. */
function createMockContext(): Record<string, unknown> {
  return new Proxy(
    {
      canvas: {},
      setTransform: () => {},
      clearRect: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      arc: () => {},
      closePath: () => {},
      fill: () => {},
      drawImage: () => {},
      ellipse: () => {},
      fillText: () => {},
      setLineDash: () => {},
      quadraticCurveTo: () => {},
      bezierCurveTo: () => {},
    },
    {
      get(target, prop) {
        return Reflect.get(target, prop)
      },
      set(target, prop, value) {
        Reflect.set(target, prop, value)
        return true
      },
    },
  )
}

describe('Tech-Space animated backdrop', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  beforeEach(() => {
    removeBackdrop()
    HTMLCanvasElement.prototype.getContext = vi.fn(() => createMockContext() as unknown as CanvasRenderingContext2D)
  })
  afterEach(() => {
    removeBackdrop()
    HTMLCanvasElement.prototype.getContext = originalGetContext
  })

  it('mounts a canvas layer when 2d context is available', () => {
    applyBackdrop(SKINS[0]!)
    expect(isAnimatedBackdrop()).toBe(true)
    expect(document.getElementById('dsh-apple-glass-canvas')).not.toBeNull()
    expect(hasBackdrop()).toBe(true)
  })

  it('updates the canvas palette on skin switch without remounting', () => {
    applyBackdrop(SKINS[0]!)
    const first = document.getElementById('dsh-apple-glass-canvas')
    applyBackdrop(SKINS[1]!)
    expect(document.getElementById('dsh-apple-glass-canvas')).toBe(first)
    expect(isAnimatedBackdrop()).toBe(true)
  })

  it('dispose removes the canvas and the fallback layer', () => {
    applyBackdrop(SKINS[0]!)
    removeBackdrop()
    expect(document.getElementById('dsh-apple-glass-canvas')).toBeNull()
    expect(document.getElementById('dsh-apple-glass-backdrop')).toBeNull()
    expect(isAnimatedBackdrop()).toBe(false)
    expect(hasBackdrop()).toBe(false)
  })
})

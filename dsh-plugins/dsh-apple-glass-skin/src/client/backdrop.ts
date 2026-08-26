/**
 * Tech-Space backdrop layer. Two cooperating layers:
 *
 * 1. A fixed animated Canvas behind the app (`z-index: -1`) rendering the
 *    deep-space HUD scene (perspective grid, sweeping scan line, drifting
 *    particles, neon glow) — visible through the translucent surface tokens
 *    at the app edges.
 * 2. A tech grid painted on the app frame (the `*_frame` layout column
 *    wrapper) with `background-attachment: fixed`, so the conversation
 *    area's blank side gutters (which have no surface of their own) show a
 *    sci-fi grid instead of flat emptiness. The sidebar keeps its own fill
 *    token and stays clean.
 *
 * Both layers are the plugin's own DOM/styles and never touch component
 * internals; a future DSH upgrade reshapes the layout, the grid rule simply
 * stops matching and the skin degrades to the canvas-only look.
 */

import type { AppleSkin, BackdropScene } from './skins.ts'
import { BackdropCanvas } from './backdrop-canvas.ts'

/** DOM id of the fixed backdrop layer (fallback gradient div). */
export const BACKDROP_ID = 'dsh-apple-glass-backdrop'


/** The live animated layer, or null while no Tech-Space skin is active. */
let canvas: BackdropCanvas | undefined

/** Whether the Canvas renderer is in use for the current skin. */
export function isAnimatedBackdrop(): boolean {
  return canvas !== undefined
}

/**
 * Ensure the scene canvas is fully visible and the app content stays above
 * it:
 *  - the canvas moves to `z-index: 0` (inline wins over the shell's
 *    stylesheet) and the app root forms a stacking context (`isolation:
 *    isolate` + `z-index: 1`), so every UI surface paints above the scene;
 *  - the app frame and the conversation column drop their own background
 *    (they are the translucent `bg-base` surfaces that would dim the scene);
 *    each card/surface keeps its own layer token, so readability holds while
 *    the animated scene shows through the open gutters.
 */
/** Frame lookup callback (set once, retried until the shell mounts). */
let frameFinder: (() => HTMLElement | undefined) | undefined
let convFinder: (() => HTMLElement | undefined) | undefined
let layerRetryTimer: ReturnType<typeof setTimeout> | undefined

function findFrame(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('div')].find(el =>
    typeof el.className === 'string' && el.className.includes('_frame'))
}
function findConv(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('div')].find(el =>
    typeof el.className === 'string' && el.className.includes('QKkIXq_root'))
}

function ensureLayerStack(): void {
  const canvas = document.getElementById('dsh-apple-glass-canvas')
  if (canvas !== null) canvas.style.zIndex = '0'
  const root = document.getElementById('root')
  if (root !== null) {
    root.style.isolation = 'isolate'
    root.style.position = 'relative'
    root.style.zIndex = '1'
  }
  // Frame / conversation surfaces may not be mounted yet during early apply:
  // retry on an interval until they appear, then clear the timer.
  const applyTransparency = (): void => {
    const frame = frameFinder?.()
    if (frame !== undefined) frame.style.backgroundColor = 'transparent'
    const conv = convFinder?.()
    if (conv !== undefined) conv.style.backgroundColor = 'transparent'
    if (frame !== undefined && conv !== undefined && layerRetryTimer !== undefined) {
      clearInterval(layerRetryTimer)
      layerRetryTimer = undefined
    }
  }
  frameFinder ??= findFrame
  convFinder ??= findConv
  applyTransparency()
  if (layerRetryTimer === undefined) {
    layerRetryTimer = setInterval(applyTransparency, 400)
  }
}

/** Remove the layer-stack overrides if present. */
function removeLayerStack(): void {
  if (layerRetryTimer !== undefined) {
    clearInterval(layerRetryTimer)
    layerRetryTimer = undefined
  }
  const canvas = document.getElementById('dsh-apple-glass-canvas')
  if (canvas !== null) canvas.style.zIndex = '-1'
  const root = document.getElementById('root')
  if (root !== null) {
    root.style.removeProperty('isolation')
    root.style.removeProperty('position')
    root.style.removeProperty('z-index')
  }
  const frame = [...document.querySelectorAll('div')].find(el =>
    typeof el.className === 'string' && el.className.includes('_frame'))
  if (frame !== undefined) frame.style.removeProperty('background-color')
  const conv = [...document.querySelectorAll('div')].find(el =>
    typeof el.className === 'string' && el.className.includes('QKkIXq_root'))
  if (conv !== undefined) conv.style.removeProperty('background-color')
}
/** Mount the backdrop layer, or update the existing one. */
export function applyBackdrop(skin: AppleSkin, scene?: BackdropScene): void {
  if (!document.body) return
  ensureLayerStack()
  // Ensure the static fallback element exists (canvas replaces it visually).
  let fallback = document.getElementById(BACKDROP_ID)
  if (fallback === null) {
    fallback = document.createElement('div')
    fallback.id = BACKDROP_ID
    fallback.setAttribute('aria-hidden', 'true')
    fallback.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;transition:background 0.45s ease;'
    document.body.prepend(fallback)
  }
  fallback.style.background = skin.backdrop

  // Animated layer: replace or reuse the existing canvas.
  if (canvas === undefined) {
    try {
      canvas = new BackdropCanvas({ ...skin.motion, scene: scene ?? skin.motion.scene })
      canvas.start()
      return
    } catch (error) {
      // 2d context unavailable (headless / exotic embed): keep the gradient.
      console.warn('[dsh-apple-glass-skin] animated backdrop unavailable, using gradient:', error)
      canvas = undefined
      return
    }
  }
  canvas.setTheme({ ...skin.motion, scene: scene ?? skin.motion.scene })
}

/** Remove the backdrop layer and any later re-adds become fresh mounts. */
export function removeBackdrop(): void {
  canvas?.dispose()
  canvas = undefined
  removeLayerStack()
  if (!document.body) return
  const el = document.getElementById(BACKDROP_ID)
  if (el !== null) el.remove()
}

/** Whether any backdrop layer (canvas or fallback) is currently mounted. */
export function hasBackdrop(): boolean {
  return canvas !== undefined || document.getElementById(BACKDROP_ID) !== null
}

/**
 * Animated Canvas backdrop: three programmatic 3D-flavored scenes rendered on
 * a fixed layer behind the app (`z-index: -1`).
 *
 * - `space` — deep-space vista: layered nebula glows, a rotating planet with
 *   atmosphere ring, drifting starfield with parallax, occasional meteors.
 * - `city` — cyberpunk skyline: procedurally generated towers with lit
 *   windows, neon accents, drifting fog, and falling rain streaks.
 * - `ocean` — underwater world: god-ray light shafts, a swimming whale
 *   silhouette with tail animation, rising bubbles, and a small fish school.
 *
 * Every scene is drawn with plain Canvas 2D (no assets, no licenses) and
 * respects the same lifecycle guardrails: pause on hidden tab,
 * prefers-reduced-motion single frame, DPR capped at 2, full teardown.
 */
import type { BackdropMotion, SceneConfig } from './skins.ts'

/** Random float in [min, max). */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** A drifting particle (star / rain / bubble). */
interface Particle {
  x: number
  y: number
  size: number
  speed: number
  alpha: number
  phase: number
}

/** One procedurally generated city tower. */
interface Tower {
  x: number
  w: number
  h: number
  hue: number
  windows: { cx: number; cy: number; on: boolean; next: number }[]
}

/** One swimming whale silhouette (drawn with bezier curves). */
interface Whale {
  y: number
  speed: number
  scale: number
  dir: 1 | -1
  x: number
}

/** A rising bubble. */
interface Bubble {
  x: number
  y: number
  r: number
  speed: number
  wobble: number
  phase: number
}

/** A small fish in the school. */
interface Fish {
  x: number
  y: number
  speed: number
  size: number
  phase: number
}

/** One falling column of the Matrix digital rain. */
interface RainColumn {
  x: number
  y: number
  speed: number
  chars: { value: string; alpha: number; highlight: boolean }[]
  next: number
}

/** A meteor streak. */
interface Meteor {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
}

/** How long a cursor-follow pulse ring expands, ms. */
const PULSE_LIFE = 1500
/** Expansion speed of a pulse ring, px/ms. */
const PULSE_SPEED = 0.30
/** Throttle for mouse-follow pulses, ms. */
const MOUSE_THROTTLE = 140

/**
 * Animated scene backdrop renderer for one Canvas element.
 */
export class BackdropCanvas {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private theme: BackdropMotion
  private width = 0
  private height = 0
  private rafId = 0
  private running = false
  private disposed = false
  private lastPulseAt = 0
  private readonly pulses: { x: number; y: number; born: number }[] = []
  // Scene state (persistent so scene switches keep motion continuity).
  private readonly stars: Particle[] = []
  private readonly towers: Tower[] = []
  private readonly whale: Whale = { y: 0, speed: 0, scale: 1, dir: 1, x: 0 }
  private readonly bubbles: Bubble[] = []
  private readonly fishes: Fish[] = []
  private readonly meteors: Meteor[] = []
  private nextMeteor = 0
  private readonly rainColumns: RainColumn[] = []
  /** Pre-rendered glow sprites for bright stars (created once, drawn with drawImage). */
  private haloSprites: Map<number, HTMLCanvasElement> | undefined
  /** Pre-rendered static nebula layer (drawn once, composited each frame). */
  private nebulaLayer: HTMLCanvasElement | undefined
  /** Pre-rendered planet body + halo (rotating bands drawn per frame). */
  private planetLayer: HTMLCanvasElement | undefined
  private readonly onVisibility = (): void => {
    if (document.hidden) this.stop()
    else this.start()
  }
  private readonly onMouse = (event: MouseEvent): void => {
    const now = performance.now()
    if (now - this.lastPulseAt < MOUSE_THROTTLE) return
    this.lastPulseAt = now
    this.spawnPulse(event.clientX, event.clientY)
  }

  constructor(theme: BackdropMotion) {
    this.theme = theme
    this.canvas = document.createElement('canvas')
    this.canvas.id = 'dsh-apple-glass-canvas'
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;width:100%;height:100%;'
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) throw new Error('2d canvas context unavailable')
    this.ctx = ctx
    document.body.prepend(this.canvas)
    this.resize()
    this.seed()
    window.addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisibility)
    document.addEventListener('mousemove', this.onMouse)
  }

  /** Swap the palette (and scene) without rebuilding the layer. */
  setTheme(theme: BackdropMotion): void {
    this.theme = theme
    this.seed()
  }

  /** Begin (or resume) the animation loop. */
  start(): void {
    if (this.disposed || this.running) return
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.drawFrame(performance.now())
      return
    }
    this.running = true
    const loop = (now: number): void => {
      if (!this.running || this.disposed) return
      try {
        this.drawFrame(now)
      } catch (error) {
        console.warn('[dsh-apple-glass-skin] backdrop frame error:', error)
      }
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  /** Pause the animation loop (keeps the last frame). */
  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  /** Remove listeners, stop the loop, and detach the canvas. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisibility)
    document.removeEventListener('mousemove', this.onMouse)
    this.canvas.remove()
  }

  private readonly onResize = (): void => {
    this.resize()
  }

  private resize(): void {
    const dpr = Math.min(2, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1)
    const width = this.canvas.clientWidth || window.innerWidth
    const height = this.canvas.clientHeight || window.innerHeight
    this.width = width
    this.height = height
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.seed()
  }

  private scene(): SceneConfig {
    return this.theme.scenes[this.theme.scene]
  }

  /** (Re)seed per-scene state on theme change or resize. */
  private seed(): void {
    const { width, height } = this
    const cfg = this.scene()
    this.stars.length = 0
    this.bubbles.length = 0
    this.fishes.length = 0
    this.meteors.length = 0
    const densityBoost = this.theme.scene === 'space' ? 2.6 : 1.5
    const target = Math.round((width / 1000) * cfg.particleDensity * densityBoost)
    for (let i = 0; i < target; i += 1) {
      this.stars.push({
        x: rand(0, width),
        y: rand(0, height),
        size: rand(1.2, this.theme.scene === 'space' ? 6.0 : this.theme.scene === 'city' ? 3.4 : 2.6),
        speed: rand(0.1, 0.5),
        alpha: rand(0.7, 1.0),
        phase: rand(0, Math.PI * 2),
      })
    }
    if (this.theme.scene === 'city') this.buildTowers()
    if (this.theme.scene === 'ocean') {
      for (let i = 0; i < 22; i += 1) {
        this.bubbles.push({
          x: rand(0, width),
          y: rand(0, height),
          r: rand(1.5, 5),
          speed: rand(0.25, 0.8),
          wobble: rand(0.5, 1.5),
          phase: rand(0, Math.PI * 2),
        })
      }
      for (let i = 0; i < 14; i += 1) {
        this.fishes.push({
          x: rand(0, width),
          y: rand(height * 0.45, height * 0.9),
          speed: rand(0.3, 0.9),
          size: rand(3, 7),
          phase: rand(0, Math.PI * 2),
        })
      }
      this.whale.x = width * 0.7
      this.whale.y = height * 0.62
      this.whale.speed = rand(0.25, 0.4)
      this.whale.scale = Math.max(0.8, Math.min(1.2, width / 1440))
      this.whale.dir = 1
    }
    if (this.theme.scene === 'space') this.nextMeteor = performance.now() + rand(3000, 9000)
    try {
      this.haloSprites = this.buildHaloSprites()
      this.nebulaLayer = this.buildNebulaLayer(cfg, width, height)
      this.planetLayer = this.buildPlanetLayer(cfg, width, height)
    } catch (error) {
      // Offscreen pre-render unavailable (headless / exotic embed): the scene
      // degrades to per-frame gradient drawing without crashing.
      this.haloSprites = undefined
      this.nebulaLayer = undefined
      this.planetLayer = undefined
    }
    if (this.theme.scene === 'matrix') {
      const cols = Math.max(60, Math.round(width / 12))
      for (let i = 0; i < cols; i += 1) {
        const charCount = Math.round(rand(10, 30))
        const chars = Array.from({ length: charCount }, () => ({
          value: Math.random() > 0.5 ? '1' : '0',
          alpha: rand(0.6, 1.0),
          highlight: Math.random() < 0.15,
        }))
        this.rainColumns.push({
          x: i * (width / cols) + rand(-6, 6),
          y: rand(-height, height),
          speed: rand(2.5, 5.5) * cfg.speed,
          chars,
          next: 0,
        })
      }
    }
  }

  /** Pre-render radial glow sprites at a few sizes, so per-frame star glows
   *  become cheap drawImage calls instead of gradient construction. */
  private buildHaloSprites(): Map<number, HTMLCanvasElement> {
    const sprites = new Map<number, HTMLCanvasElement>()
    for (const size of [2, 3, 4, 6]) {
      const canvas = document.createElement('canvas')
      const px = size * 12
      canvas.width = px
      canvas.height = px
      const c = canvas.getContext('2d')
      if (c === null) continue
      const grad = c.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2)
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.85)')
      grad.addColorStop(0.25, 'rgba(200, 235, 255, 0.45)')
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
      c.fillStyle = grad
      c.fillRect(0, 0, px, px)
      sprites.set(size, canvas)
    }
    return sprites
  }

  /** Pre-render the static nebula clouds to an offscreen canvas once, then
   *  composite with a single drawImage per frame (radial gradients are the
   *  most expensive canvas ops; doing 11 of them every frame tanked fps). */
  private buildNebulaLayer(cfg: SceneConfig, width: number, height: number): HTMLCanvasElement | undefined {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const c = canvas.getContext('2d')
    if (c === null) return undefined
    const n = (cx: number, cy: number, r: number, color: string, alpha: number): void => {
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0, color)
      g.addColorStop(0.6, color)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      c.globalAlpha = alpha
      c.fillStyle = g
      c.beginPath()
      c.arc(cx, cy, r, 0, Math.PI * 2)
      c.fill()
      c.globalAlpha = 1
    }
    const max = Math.max(width, height)
    // Base accent nebulae (same placement as before).
    n(width * 0.24, height * 0.30, max * 0.62, cfg.accent, 0.50)
    n(width * 0.80, height * 0.22, max * 0.54, cfg.accent2, 0.42)
    n(width * 0.55, height * 0.85, max * 0.68, cfg.accent, 0.34)
    n(width * 0.40, height * 0.55, max * 0.35, cfg.accent2, 0.20)
    n(width * 0.15, height * 0.70, max * 0.30, cfg.accent, 0.16)
    n(width * 0.92, height * 0.65, max * 0.28, cfg.accent2, 0.15)
    // Colored wisps.
    n(width * 0.18, height * 0.28, max * 0.30, 'rgba(90, 60, 200, 0.34)', 0.30)
    n(width * 0.30, height * 0.35, max * 0.22, 'rgba(200, 80, 180, 0.22)', 0.28)
    n(width * 0.85, height * 0.30, max * 0.26, 'rgba(60, 140, 255, 0.30)', 0.30)
    n(width * 0.72, height * 0.20, max * 0.18, 'rgba(140, 90, 255, 0.24)', 0.26)
    n(width * 0.55, height * 0.88, max * 0.32, 'rgba(40, 110, 220, 0.26)', 0.28)
    return canvas
  }

  /** Pre-render the planet body, halo and rings once; only the rotating cloud
   *  bands stay dynamic per frame. */
  private buildPlanetLayer(cfg: SceneConfig, width: number, height: number): HTMLCanvasElement | undefined {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const c = canvas.getContext('2d')
    if (c === null) return undefined
    const cx = width * 0.72
    const cy = height * 0.32
    const r = Math.min(width, height) * 0.22
    // Atmosphere halo.
    const halo = c.createRadialGradient(cx, cy, r * 0.7, cx, cy, r * 1.8)
    halo.addColorStop(0, 'rgba(120, 200, 255, 0.34)')
    halo.addColorStop(1, 'rgba(0,0,0,0)')
    c.fillStyle = halo
    c.beginPath()
    c.arc(cx, cy, r * 1.8, 0, Math.PI * 2)
    c.fill()
    // Body.
    const body = c.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.2, cx, cy, r)
    body.addColorStop(0, '#8ab8e8')
    body.addColorStop(0.45, '#3a5a8e')
    body.addColorStop(0.8, '#1a3460')
    body.addColorStop(1, '#0e2040')
    c.fillStyle = body
    c.beginPath()
    c.arc(cx, cy, r, 0, Math.PI * 2)
    c.fill()
    // Static cloud band base (two soft bands baked in).
    c.save()
    c.beginPath()
    c.arc(cx, cy, r, 0, Math.PI * 2)
    c.clip()
    for (const by of [cy - r * 0.2, cy + r * 0.15]) {
      const bandR = Math.sqrt(Math.max(0, r * r - (by - cy) * (by - cy)))
      if (bandR <= 0) continue
      c.fillStyle = 'rgba(210, 235, 255, 0.12)'
      c.beginPath()
      c.ellipse(cx, by, bandR, r * 0.07, 0, 0, Math.PI * 2)
      c.fill()
    }
    c.restore()
    // Rings.
    c.save()
    c.translate(cx, cy)
    c.rotate(-0.28)
    c.strokeStyle = 'rgba(180, 220, 255, 0.65)'
    c.lineWidth = 4
    c.beginPath()
    c.ellipse(0, 0, r * 1.9, r * 0.42, 0, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = 'rgba(220, 240, 255, 0.42)'
    c.lineWidth = 2
    c.beginPath()
    c.ellipse(0, 0, r * 2.15, r * 0.5, 0, 0, Math.PI * 2)
    c.stroke()
    c.restore()
    return canvas
  }

  private spawnPulse(x: number, y: number): void {
    this.pulses.push({ x, y, born: performance.now() })
    if (this.pulses.length > 16) this.pulses.shift()
  }

  /** Draw the active scene for this frame. */
  private drawFrame(now: number): void {
    const { ctx, width, height } = this
    if (width === 0 || height === 0) return
    ctx.clearRect(0, 0, width, height)
    switch (this.theme.scene) {
      case 'space': this.drawSpace(now); break
      case 'city': this.drawCity(now); break
      case 'ocean': this.drawOcean(now); break
      case 'matrix': this.drawMatrix(now); break
    }
  }

  private drawPulses(now: number): void {
    const { ctx } = this
    for (let i = this.pulses.length - 1; i >= 0; i -= 1) {
      const pulse = this.pulses[i]
      if (pulse === undefined) continue
      const age = now - pulse.born
      if (age < 0 || age > PULSE_LIFE) { this.pulses.splice(i, 1); continue }
      const life = age / PULSE_LIFE
      const radius = Math.max(0.5, age * PULSE_SPEED)
      ctx.strokeStyle = this.scene().particle
      ctx.globalAlpha = 0.45 * (1 - life)
      ctx.lineWidth = 1.4
      for (const ring of [0.4, 0.75, 1]) {
        ctx.beginPath()
        ctx.arc(pulse.x, pulse.y, radius * ring, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  // ---- Scene: deep space --------------------------------------------------
  private drawSpace(now: number): void {
    const { ctx, width, height } = this
    const cfg = this.scene()
    const t = now / 1000

    // Sky gradient.
    const sky = ctx.createLinearGradient(0, 0, 0, height)
    sky.addColorStop(0, cfg.base[0])
    sky.addColorStop(1, cfg.base[1])
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, width, height)

    // Nebula layer: pre-rendered once, composited with a slow breathing alpha.
    // Falls back to per-frame gradients when offscreen pre-render is unavailable.
    if (this.nebulaLayer !== undefined) {
      ctx.globalAlpha = 0.92 + 0.08 * Math.sin(t * 0.25)
      ctx.drawImage(this.nebulaLayer, 0, 0)
      ctx.globalAlpha = 1
    } else {
      const max = Math.max(width, height)
      this.nebula(width * 0.24, height * 0.30, max * 0.62, cfg.accent, 0.50 + 0.08 * Math.sin(t * 0.3), t)
      this.nebula(width * 0.80, height * 0.22, max * 0.54, cfg.accent2, 0.42 + 0.07 * Math.sin(t * 0.22 + 2), t)
      this.nebula(width * 0.55, height * 0.85, max * 0.68, cfg.accent, 0.34 + 0.06 * Math.sin(t * 0.18 + 4), t)
    }

    // Small moon on the left for balance.
    this.drawMoon(now)
    // Rotating planet: pre-rendered body, or full per-frame fallback.
    if (this.planetLayer !== undefined) {
      this.drawPlanet(now)
    } else {
      this.drawPlanetFull(now)
    }

    // Starfield with twinkle (glows via pre-rendered sprites).
    for (const star of this.stars) {
      const twinkle = 0.55 + 0.45 * Math.sin(t * 1.8 + star.phase)
      // Glow sprite first (behind the dot).
      if (star.size > 1.0 && this.haloSprites !== undefined) {
        const sprite = this.haloSprites.get(star.size >= 4 ? 6 : star.size >= 3 ? 4 : star.size >= 2 ? 3 : 2)
        if (sprite !== undefined) {
          const half = sprite.width / 2
          ctx.globalAlpha = 0.55 * twinkle * star.alpha
          ctx.drawImage(sprite, star.x - half, star.y - half)
        }
      }
      // Core dot.
      ctx.fillStyle = cfg.particle
      ctx.globalAlpha = Math.max(0.5, star.alpha * twinkle)
      ctx.beginPath()
      ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2)
      ctx.fill()
      // Cross glint for the brighter stars.
      if (star.size > 1.8 && twinkle > 0.8) {
        ctx.globalAlpha = 0.55 * twinkle
        ctx.fillRect(star.x - star.size * 2.5, star.y, star.size * 5, 0.8)
        ctx.fillRect(star.x, star.y - star.size * 2.5, 0.8, star.size * 5)
      }
    }
    ctx.globalAlpha = 1

    // Meteors.
    if (now > this.nextMeteor) {
      this.meteors.push({
        x: rand(0, width * 0.8),
        y: rand(0, height * 0.3),
        vx: rand(3.5, 6),
        vy: rand(1.8, 3),
        life: 0,
        max: rand(50, 90),
      })
      this.nextMeteor = now + rand(2500, 6500)
    }
    for (let i = this.meteors.length - 1; i >= 0; i -= 1) {
      const m = this.meteors[i]
      if (m === undefined) continue
      m.life += 1
      m.x += m.vx
      m.y += m.vy
      if (m.life > m.max) { this.meteors.splice(i, 1); continue }
      const fade = 1 - m.life / m.max
      const tail = 46
      const g = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 3, m.y - m.vy * 3)
      g.addColorStop(0, cfg.particle)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.strokeStyle = g
      ctx.globalAlpha = fade
      ctx.lineWidth = 2.2
      ctx.beginPath()
      ctx.moveTo(m.x, m.y)
      ctx.lineTo(m.x - m.vx * 3, m.y - m.vy * 3)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    this.drawPulses(now)
  }

  /** One soft nebula cloud (radial glow, slow drift). */
  private nebula(cx: number, cy: number, r: number, color: string, alpha: number, t: number): void {
    const { ctx } = this
    const x = cx + Math.sin(t * 0.12) * r * 0.08
    const y = cy + Math.cos(t * 0.09) * r * 0.06
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, color)
    g.addColorStop(0.6, color)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = alpha
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }

  /** A small cratered moon on the left, balancing the composition. */
  private drawMoon(now: number): void {
    const { ctx, width, height } = this
    const cfg = this.scene()
    const t = now / 1000
    const cx = width * 0.12
    const cy = height * 0.72
    const r = Math.min(width, height) * 0.055

    // Atmosphere halo.
    const halo = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2)
    halo.addColorStop(0, 'rgba(160, 210, 255, 0.14)')
    halo.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(cx, cy, r * 2, 0, Math.PI * 2)
    ctx.fill()

    // Body.
    const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.15, cx, cy, r)
    body.addColorStop(0, '#5a7ea8')
    body.addColorStop(0.6, '#3a5a82')
    body.addColorStop(1, '#203650')
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()

    // Craters.
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = 'rgba(20, 40, 65, 0.5)'
    for (const [ox, oy, cr] of [[-0.3, -0.2, 0.22], [0.2, 0.1, 0.16], [-0.05, 0.35, 0.12], [0.35, -0.3, 0.1]] as const) {
      ctx.beginPath()
      ctx.arc(cx + ox * r, cy + oy * r, cr * r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    // Terminator.
    const shade = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r)
    shade.addColorStop(0, 'rgba(0,0,0,0)')
    shade.addColorStop(1, 'rgba(0,0,0,0.5)')
    ctx.fillStyle = shade
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()

    // Faint orbit arc.
    ctx.strokeStyle = cfg.particle
    ctx.globalAlpha = 0.12
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.ellipse(cx, cy, r * 1.9, r * 0.5, -0.3, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  /** A rotating gas-giant planet with an atmosphere halo and ring. */
  /** Full per-frame planet renderer (fallback when offscreen pre-render is
   *  unavailable, e.g. headless jsdom). */
  private drawPlanetFull(now: number): void {
    const { ctx, width, height } = this
    const t = now / 1000
    const cx = width * 0.72
    const cy = height * 0.32
    const r = Math.min(width, height) * 0.22
    const halo = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r * 1.8)
    halo.addColorStop(0, 'rgba(120, 200, 255, 0.34)')
    halo.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(cx, cy, r * 1.8, 0, Math.PI * 2)
    ctx.fill()
    const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.2, cx, cy, r)
    body.addColorStop(0, '#8ab8e8')
    body.addColorStop(0.45, '#3a5a8e')
    body.addColorStop(0.8, '#1a3460')
    body.addColorStop(1, '#0e2040')
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.clip()
    const bandShift = (t * 6) % (r * 2)
    for (let i = -1; i < 5; i += 1) {
      const by = cy - r + i * (r * 0.38) + bandShift * 0.3
      const bandR = Math.sqrt(Math.max(0, r * r - (by - cy) * (by - cy)))
      if (bandR <= 0) continue
      ctx.fillStyle = 'rgba(210, 235, 255, 0.10)'
      ctx.beginPath()
      ctx.ellipse(cx, by, bandR, r * 0.06, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    const shade = ctx.createLinearGradient(cx - r * 0.6, cy - r, cx + r * 0.6, cy + r)
    shade.addColorStop(0, 'rgba(0,0,0,0)')
    shade.addColorStop(0.55, 'rgba(0,0,0,0.10)')
    shade.addColorStop(1, 'rgba(0,0,0,0.62)')
    ctx.fillStyle = shade
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
    ctx.restore()
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(-0.28)
    ctx.strokeStyle = 'rgba(180, 220, 255, 0.65)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.ellipse(0, 0, r * 1.9, r * 0.42, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(220, 240, 255, 0.42)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.ellipse(0, 0, r * 2.15, r * 0.5, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  /** A rotating gas-giant planet: composites the pre-rendered body + rings and
   *  draws only the slowly rotating cloud bands per frame. */
  private drawPlanet(now: number): void {
    const { ctx, width, height } = this
    const t = now / 1000
    if (this.planetLayer !== undefined) {
      ctx.drawImage(this.planetLayer, 0, 0)
    }
    const cx = width * 0.72
    const cy = height * 0.32
    const r = Math.min(width, height) * 0.22
    // Rotating cloud bands (the only dynamic part of the planet).
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.clip()
    const bandShift = (t * 6) % (r * 2)
    for (let i = -1; i < 5; i += 1) {
      const by = cy - r + i * (r * 0.38) + bandShift * 0.3
      const bandR = Math.sqrt(Math.max(0, r * r - (by - cy) * (by - cy)))
      if (bandR <= 0) continue
      ctx.fillStyle = 'rgba(210, 235, 255, 0.10)'
      ctx.beginPath()
      ctx.ellipse(cx, by, bandR, r * 0.06, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    // Terminator shadow.
    const shade = ctx.createLinearGradient(cx - r * 0.6, cy - r, cx + r * 0.6, cy + r)
    shade.addColorStop(0, 'rgba(0,0,0,0)')
    shade.addColorStop(0.55, 'rgba(0,0,0,0.10)')
    shade.addColorStop(1, 'rgba(0,0,0,0.62)')
    ctx.fillStyle = shade
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
    ctx.restore()
  }

  // ---- Scene: cyberpunk city ----------------------------------------------
  private buildTowers(): void {
    const { width, height } = this
    this.towers.length = 0
    const count = Math.max(10, Math.round(width / 90))
    let x = -20
    for (let i = 0; i < count && x < width + 20; i += 1) {
      const w = rand(40, 90)
      const h = rand(height * 0.35, height * 0.82)
      const tower: Tower = { x, w, h, hue: i % 3, windows: [] }
      // Windows grid.
      const cols = Math.max(2, Math.floor(w / 12))
      const rows = Math.max(4, Math.floor(h / 16))
      for (let cy = 0; cy < rows; cy += 1) {
        for (let cx = 0; cx < cols; cx += 1) {
          tower.windows.push({
            cx: x + 6 + cx * ((w - 12) / Math.max(1, cols - 1)),
            cy: height - h + 10 + cy * ((h - 20) / Math.max(1, rows - 1)),
            on: Math.random() > 0.45,
            next: performance.now() + rand(2000, 12000),
          })
        }
      }
      this.towers.push(tower)
      x += w + rand(2, 14)
    }
  }

  private drawCity(now: number): void {
    const { ctx, width, height } = this
    const cfg = this.scene()
    const t = now / 1000

    // Sky gradient.
    const sky = ctx.createLinearGradient(0, 0, 0, height)
    sky.addColorStop(0, cfg.base[0])
    sky.addColorStop(1, cfg.base[1])
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, width, height)

    // Distant glow behind the skyline.
    const glow = ctx.createRadialGradient(width * 0.5, height * 0.78, 0, width * 0.5, height * 0.78, width * 0.7)
    glow.addColorStop(0, cfg.accent)
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 0.22 + 0.05 * Math.sin(t * 0.4)
    ctx.fillStyle = glow
    ctx.fillRect(0, height * 0.5, width, height * 0.5)
    ctx.globalAlpha = 1

    // Towers (back-to-front two layers for depth).
    this.drawTowerLayer(0.5, cfg, now, true)
    this.drawTowerLayer(1, cfg, now, false)

    // Rain.
    for (const drop of this.stars) {
      drop.y += drop.speed * 5
      drop.x -= drop.speed * 1.6
      if (drop.y > height) { drop.y = -8; drop.x = rand(0, width) }
      if (drop.x < -8) drop.x = width + 8
      ctx.strokeStyle = cfg.particle
      ctx.globalAlpha = drop.alpha * 0.6
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(drop.x, drop.y)
      ctx.lineTo(drop.x + 2, drop.y - 12)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    this.drawPulses(now)
  }

  private drawTowerLayer(scale: number, cfg: SceneConfig, now: number, back: boolean): void {
    const { ctx, height } = this
    for (const tower of this.towers) {
      const tx = tower.x * scale
      const tw = tower.w * scale
      const th = tower.h * scale
      const ty = height - th
      // Tower body.
      ctx.fillStyle = back
        ? 'rgba(8, 12, 22, 0.82)'
        : 'rgba(10, 16, 30, 0.94)'
      ctx.fillRect(tx, ty, tw, th)
      // Neon edge.
      ctx.strokeStyle = tower.hue === 0 ? cfg.accent : tower.hue === 1 ? cfg.accent2 : 'rgba(255, 220, 120, 0.35)'
      ctx.globalAlpha = back ? 0.5 : 0.9
      ctx.lineWidth = 1.4
      ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1)
      // Roof antenna.
      if (!back && tower.hue === 0) {
        ctx.strokeStyle = cfg.accent
        ctx.globalAlpha = 0.7 + 0.3 * Math.sin(now / 500 + tower.x)
        ctx.beginPath()
        ctx.moveTo(tx + tw / 2, ty)
        ctx.lineTo(tx + tw / 2, ty - 14)
        ctx.stroke()
        ctx.fillStyle = cfg.accent
        ctx.beginPath()
        ctx.arc(tx + tw / 2, ty - 16, 2, 0, Math.PI * 2)
        ctx.fill()
      }
      // Windows (with random on/off flicker).
      for (const win of tower.windows) {
        if (win.on) {
          ctx.globalAlpha = back ? 0.6 : 1.0
          ctx.fillStyle = tower.hue === 0 ? 'rgba(140, 230, 255, 0.9)' : tower.hue === 1 ? 'rgba(255, 150, 200, 0.85)' : 'rgba(255, 220, 140, 0.85)'
          ctx.fillRect(win.cx * scale, win.cy * scale, 4 * scale, 5 * scale)
        }
      }
      ctx.globalAlpha = 1
    }
  }

  // ---- Scene: underwater ---------------------------------------------------
  private drawOcean(now: number): void {
    const { ctx, width, height } = this
    const cfg = this.scene()
    const t = now / 1000

    // Water gradient.
    const water = ctx.createLinearGradient(0, 0, 0, height)
    water.addColorStop(0, cfg.base[0])
    water.addColorStop(1, cfg.base[1])
    ctx.fillStyle = water
    ctx.fillRect(0, 0, width, height)

    // God-ray light shafts from the surface (slow sway).
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    for (let i = 0; i < 4; i += 1) {
      const shaftX = width * (0.15 + i * 0.24) + Math.sin(t * 0.1 + i * 1.7) * 30
      const sway = Math.sin(t * 0.14 + i) * 0.06
      const grad = ctx.createLinearGradient(shaftX, 0, shaftX + Math.tan(sway) * height * 0.6, height)
      grad.addColorStop(0, cfg.accent)
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.moveTo(shaftX - 40, 0)
      ctx.lineTo(shaftX + 40, 0)
      ctx.lineTo(shaftX + 40 + Math.tan(sway) * height, height)
      ctx.lineTo(shaftX - 40 + Math.tan(sway) * height, height)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()

    // Caustic shimmer bands.
    for (let i = 0; i < 6; i += 1) {
      const y = height * 0.2 + i * (height * 0.09) + Math.sin(t * 0.5 + i) * 8
      ctx.strokeStyle = cfg.accent2
      ctx.globalAlpha = 0.06
      ctx.lineWidth = 26
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.quadraticCurveTo(width * 0.3, y + Math.sin(t * 0.4 + i) * 40, width, y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // Whale.
    this.drawWhale(now)

    // Fish school.
    for (const fish of this.fishes) {
      fish.x -= fish.speed
      if (fish.x < -20) { fish.x = width + 20; fish.y = rand(height * 0.45, height * 0.9) }
      const bob = Math.sin(t * 2 + fish.phase) * 4
      ctx.fillStyle = cfg.accent2
      ctx.globalAlpha = 0.5
      ctx.beginPath()
      ctx.ellipse(fish.x, fish.y + bob, fish.size, fish.size * 0.5, 0, 0, Math.PI * 2)
      ctx.fill()
      // Tail flick.
      ctx.beginPath()
      ctx.moveTo(fish.x + fish.size, fish.y + bob)
      ctx.lineTo(fish.x + fish.size + fish.size * 0.7, fish.y + bob - 3)
      ctx.lineTo(fish.x + fish.size + fish.size * 0.7, fish.y + bob + 3)
      ctx.closePath()
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // Bubbles.
    for (const b of this.bubbles) {
      b.y -= b.speed
      b.x += Math.sin(t * 1.2 + b.phase) * b.wobble * 0.3
      if (b.y < -10) { b.y = height + 10; b.x = rand(0, width) }
      ctx.strokeStyle = cfg.particle
      ctx.globalAlpha = 0.35
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
      ctx.stroke()
      // Highlight dot.
      ctx.fillStyle = cfg.particle
      ctx.globalAlpha = 0.4
      ctx.beginPath()
      ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.22, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    this.drawPulses(now)
  }

  /** A gracefully swimming whale silhouette. */
  private drawWhale(now: number): void {
    const { ctx, width, height } = this
    const cfg = this.scene()
    const w = this.whale
    const t = now / 1000
    w.x -= w.speed * w.dir
    if (w.x < -width * 0.25 || w.x > width * 1.25) {
      w.dir = w.dir === 1 ? -1 : 1
      w.y = height * rand(0.5, 0.8)
    }
    const bob = Math.sin(t * 0.4) * 14
    const y = w.y + bob
    const len = 340 * w.scale
    const hgt = 105 * w.scale
    const cx = w.x
    const dir = w.dir
    // Tail oscillation (slow beat).
    const tail = Math.sin(t * 1.6) * 14

    ctx.save()
    ctx.translate(cx, y)
    ctx.scale(dir, 1)
    // Body (rounded hull).
    ctx.fillStyle = 'rgba(14, 42, 68, 0.96)'
    ctx.beginPath()
    ctx.moveTo(-len * 0.5, 0)
    ctx.bezierCurveTo(-len * 0.45, -hgt * 0.9, -len * 0.1, -hgt * 1.05, len * 0.22, -hgt * 0.5)
    ctx.bezierCurveTo(len * 0.42, -hgt * 0.18, len * 0.5, -hgt * 0.08, len * 0.5, 0)
    ctx.bezierCurveTo(len * 0.5, hgt * 0.22, len * 0.2, hgt * 0.6, -len * 0.1, hgt * 0.42)
    ctx.bezierCurveTo(-len * 0.38, hgt * 0.2, -len * 0.48, hgt * 0.05, -len * 0.5, 0)
    ctx.closePath()
    ctx.fill()
    // Belly lighter patch.
    ctx.fillStyle = 'rgba(150, 215, 255, 0.10)'
    ctx.beginPath()
    ctx.ellipse(-len * 0.02, hgt * 0.16, len * 0.34, hgt * 0.24, 0, 0, Math.PI * 2)
    ctx.fill()
    // Tail fluke.
    ctx.fillStyle = 'rgba(14, 42, 68, 0.96)'
    ctx.beginPath()
    ctx.moveTo(-len * 0.48, 0)
    ctx.quadraticCurveTo(-len * 0.58, -tail * 0.4, -len * 0.66, -tail)
    ctx.quadraticCurveTo(-len * 0.6, -tail * 0.2, -len * 0.56, 0)
    ctx.quadraticCurveTo(-len * 0.6, tail * 0.2, -len * 0.66, tail)
    ctx.quadraticCurveTo(-len * 0.58, tail * 0.4, -len * 0.48, 0)
    ctx.closePath()
    ctx.fill()
    // Flipper.
    ctx.beginPath()
    ctx.moveTo(len * 0.06, hgt * 0.2)
    ctx.quadraticCurveTo(len * 0.16, hgt * 0.5, len * 0.05, hgt * 0.62)
    ctx.quadraticCurveTo(len * 0.0, hgt * 0.5, len * 0.0, hgt * 0.3)
    ctx.closePath()
    ctx.fill()
    // Eye.
    ctx.fillStyle = 'rgba(210, 240, 255, 0.9)'
    ctx.beginPath()
    ctx.arc(len * 0.28, -hgt * 0.12, 3.4 * w.scale, 0, Math.PI * 2)
    ctx.fill()
    // Silhouette outline for definition against the water.
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.28)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(-len * 0.5, 0)
    ctx.bezierCurveTo(-len * 0.45, -hgt * 0.9, -len * 0.1, -hgt * 1.05, len * 0.22, -hgt * 0.5)
    ctx.bezierCurveTo(len * 0.42, -hgt * 0.18, len * 0.5, -hgt * 0.08, len * 0.5, 0)
    ctx.bezierCurveTo(len * 0.5, hgt * 0.22, len * 0.2, hgt * 0.6, -len * 0.1, hgt * 0.42)
    ctx.bezierCurveTo(-len * 0.38, hgt * 0.2, -len * 0.48, hgt * 0.05, -len * 0.5, 0)
    ctx.closePath()
    ctx.stroke()
    // Blowhole spout occasionally.
    const spoutCycle = (t * 0.5 + w.x * 0.002) % 1
    if (spoutCycle > 0.86 && spoutCycle < 0.98) {
      const p = (spoutCycle - 0.86) / 0.12
      ctx.strokeStyle = cfg.particle
      ctx.globalAlpha = 0.4 * (1 - p)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(-len * 0.06, -hgt * 0.8)
      ctx.quadraticCurveTo(-len * 0.08 - p * 14, -hgt * 0.8 - p * 40, -len * 0.02, -hgt * 0.8 - p * 55)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }

  // ---- Scene: Matrix digital rain -------------------------------------------
  private drawMatrix(now: number): void {
    const { ctx, width, height } = this
    const cfg = this.scene()

    // Faint black-green background.
    const bg = ctx.createLinearGradient(0, 0, 0, height)
    bg.addColorStop(0, cfg.base[0])
    bg.addColorStop(1, cfg.base[1])
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    // A translucent fade for trailing (drawn once per frame over the old
    // frame is a classic matrix look, but we redraw everything each frame so
    // the background gradient doubles as the trail veil).
    ctx.font = 'bold 15px monospace'
    ctx.textBaseline = 'top'

    for (const col of this.rainColumns) {
      col.y += col.speed * 1.8
      // Recycle off-screen columns.
      if (col.y - col.chars.length * 15 > height + 60) {
        col.y = -col.chars.length * 15
        col.x = rand(0, width)
        col.speed = rand(1.4, 3.2) * cfg.speed
        for (const c of col.chars) {
          c.value = Math.random() > 0.5 ? '1' : '0'
          c.alpha = rand(0.35, 0.9)
          c.highlight = Math.random() < 0.12
        }
      }
      // Occasionally flip a character to 1/0 (live "hacking" feel).
      col.next += 1
      if (col.next > 40) {
        col.next = 0
        const c = col.chars[Math.floor(rand(0, col.chars.length))]
        if (c !== undefined) c.value = c.value === '0' ? '1' : '0'
      }
      for (let i = 0; i < col.chars.length; i += 1) {
        const c = col.chars[i]
        if (c === undefined) continue
        const y = col.y - i * 15
        if (y < -16 || y > height) continue
        if (c.highlight) {
          ctx.fillStyle = 'rgba(235, 255, 240, 1)'
          ctx.fillText(c.value, col.x, y)
        } else {
          ctx.fillStyle = cfg.accent
          ctx.globalAlpha = c.alpha
          ctx.fillText(c.value, col.x, y)
          ctx.globalAlpha = 1
        }
      }
    }
    ctx.globalAlpha = 1

    this.drawPulses(now)
  }
}

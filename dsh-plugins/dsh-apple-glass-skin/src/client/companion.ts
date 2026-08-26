/**
 * AI companion — a cute pixel-art girl that lives on the page corner and
 * reflects the agent's live state (thinking / working / idle / asleep) plus
 * real UI info read from the page (current session title, active model,
 * message counts) and an energy ("体力") bar so the manager can see at a
 * glance whether the AI worker still has budget to be paid.
 *
 * The girl is drawn programmatically on a small canvas (pixel-grid → scaled
 * rects), so there is no image asset and no licensing concern. State and UI
 * info come from observing the DOM (stable structural heuristics, never CSS
 * module hashes), not from DSH internals. Energy is a "workday" meter: each
 * completed assistant round (a thinking block settling to `ok`) counts as
 * one unit of work, drawn against a monthly round budget — the manager's
 * "salary" metaphor. All settings live in localStorage, matching the plugin's
 * boundary.
 */

import { createCompanionScene, animateCompanion3D, resizeCompanion3D } from './companion-3d.ts'

/** Escape HTML so session/model text cannot inject markup. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Monthly work-round budget (energy capacity). */
const BUDGET_KEY = 'dsh-apple-glass-skin:energy-budget'
/** Rounds already counted (persisted so reloads do not reset the meter). */
const USED_KEY = 'dsh-apple-glass-skin:energy-used'
/** Default monthly budget in rounds. */
const DEFAULT_BUDGET = 200

/** Pixel girl sprite: one character per pixel, drawn at a 6x scale. */
const SPRITE = [
  '..HH......HH..',
  '.HHH......HHH.',
  '...HHHHHHHH...',
  '..HHHHHHHHHH..',
  '..HFFFFFFFFH..',
  '.HFEFFFFEFH...',
  '.HFFFFFFFFH...',
  '.HFFSFFSFFH...',
  '..HFFFFFFFH...',
  '...HHHHHHHH...',
  '....BBBBBB....',
  '...BBBBBBBB...',
  '..BBBBBBBBBB..',
  '..BBB....BBB..',
  '..BB......BB..',
] as const

/** Palette keyed by sprite characters. */
const PALETTE: Record<string, string> = {
  H: '#3b2a1a',
  F: '#ffdfc4',
  E: '#1a1a2e',
  S: '#ffb3c1',
  B: '#4a90d9',
  R: '#ff6b81',
}

/** Scale of each sprite pixel in CSS px. */
const PX = 6
const SPRITE_W = SPRITE[0]!.length
const SPRITE_H = SPRITE.length

/** Live states the companion reports. */
type CompanionState = 'thinking' | 'working' | 'idle' | 'asleep'

/** Read an integer from localStorage with a fallback. */
function readInt(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null || raw.trim() === '') return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  } catch {
    return fallback
  }
}

/** Write an integer to localStorage (best-effort). */
function writeInt(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // storage unavailable — the meter still works for this session
  }
}

/**
 * Read the current session title from the sidebar. DSH class names are CSS
 * module hashes that change every build, so this walks the sidebar rows and
 * picks the title of the selected row structurally. Returns null when the
 * UI has not rendered yet or the shape changed.
 */
function readSessionTitle(): string | null {
  const rows = document.querySelectorAll('[class*="sessionRow"]')
  for (const row of rows) {
    const cls = typeof row.className === 'string' ? row.className : ''
    if (!cls.includes('selected')) continue
    // The first short text inside the row is the session title.
    const texts = [...row.querySelectorAll<HTMLElement>('span, div')]
      .map(el => (el.innerText || '').trim())
      .filter(t => t.length > 0 && t.length < 60)
    return texts[0] ?? ((row as HTMLElement).innerText || '').trim().split('\n')[0] ?? null
  }
  return null
}

/**
 * Read the active model name. DSH renders the model as a short text token
 * (e.g. "DeepSeek-V4-Flash") inside the composer card, near the permission /
 * reasoning mode text. Workspace names (e.g. "dsh-plugins") match a naive
 * vendor-model regex, so the lookup scopes to the composer region first and
 * requires a leading letter plus a plausible vendor/model shape.
 */
/**
 * Read the active model name. DSH renders the model as a single-line token
 * (e.g. "DeepSeek-V4-Flash") inside the composer card, on the same card that
 * also renders the permission ("Full access") and reasoning-mode text
 * ("High"/"Low"). Workspace names like "dsh-plugins" also match a loose
 * vendor-model regex, so the lookup requires a leaf with no newline that
 * sits inside a composer card carrying the permission text, then falls back
 * to any newline-free leaf with a leading capital letter.
 */
function readModelName(): string | null {
  const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]')
  if (input !== null) {
    let el: HTMLElement | null = input.parentElement
    let best: string | null = null
    for (let depth = 0; depth < 10 && el !== null; depth += 1) {
      const block = (el.innerText || '').trim()
      const hasPermission = block.includes('Full access') || block.includes('Read-only') || block.includes('No access')
      if (hasPermission) {
        for (const node of el.querySelectorAll<HTMLElement>('span, div')) {
          const text = (node.innerText || '').trim()
          // Single-line, short, capital-led, vendor/model shape.
          if (text.length > 1 && text.length < 50 && !text.includes('\n')
            && /^[A-Z][A-Za-z0-9.]*[-/][A-Za-z0-9._-]+$/.test(text)) {
            best = text
            break
          }
        }
        if (best !== null) break
      }
      el = el.parentElement
    }
    if (best !== null) return best
  }
  // Fallback: any newline-free capital-led vendor/model-shaped leaf.
  const candidates = document.querySelectorAll<HTMLElement>('span, div, button')
  for (const el of candidates) {
    const text = (el.innerText || '').trim()
    if (text.length < 2 || text.length > 50 || text.includes('\n')) continue
    if (el.children.length > 0) continue
    if (/^[A-Z][A-Za-z0-9.]*[-/][A-Za-z0-9._-]+$/.test(text)) return text
  }
  return null
}

/**
 * Count assistant turns and user messages currently in the DOM. DSH marks
 * assistant turns with data-variant="think" rows and message blocks with
 * data-state; both are stable data attributes (not class hashes).
 */
function readMessageStats(): { turns: number, messages: number } {
  const turns = document.querySelectorAll('[data-variant="think"]').length
  const messages = document.querySelectorAll('[data-variant="think"], [data-state="ok"], [data-state="running"]').length
  return { turns, messages }
}

/**
 * Mount the companion; returns the disposer removing everything.
 */
export function mountCompanion(): () => void {
  // ---- DOM scaffold -------------------------------------------------------
  const root = document.createElement('div')
  root.id = 'dsh-apple-glass-companion'
  root.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000;user-select:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;'

  const canvas = document.createElement('canvas')
  canvas.width = 440
  canvas.height = 300
  canvas.style.cssText = 'width:220px;height:150px;filter:drop-shadow(0 6px 14px rgba(0,0,0,0.25));'
  const statusEl = document.createElement('div')
  statusEl.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);font-size:11px;line-height:15px;font-style:normal;padding:2px 7px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 78%,transparent);backdrop-filter:blur(3px);pointer-events:none;white-space:nowrap;max-width:220px;text-align:center;z-index:3;'
  root.appendChild(statusEl)
  root.appendChild(canvas)

  const energyEl = document.createElement('div')
  energyEl.style.cssText = 'width:76px;height:7px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);'
  const energyFill = document.createElement('div')
  energyFill.style.cssText = 'height:100%;width:100%;border-radius:4px;background:linear-gradient(90deg,#34c759,#0a84ff);transition:width 0.4s ease;'
  energyEl.appendChild(energyFill)
  root.appendChild(energyEl)

  document.body.appendChild(root)

  // ---- state + energy -----------------------------------------------------
  let state: CompanionState = 'idle'
  const used = readInt(USED_KEY, 0)
  const budget = Math.max(1, readInt(BUDGET_KEY, DEFAULT_BUDGET))

  // Prefer the 3D figure; fall back to pixel art when Three.js cannot load
  // (offline / blocked CDN) or WebGL is unavailable.
  let scene3D: Awaited<ReturnType<typeof createCompanionScene>> | undefined
  let ctx: CanvasRenderingContext2D | null = null
  let started3D = false
  void createCompanionScene(canvas).then((s3d) => {
    if (!running) return
    scene3D = s3d
    resizeCompanion3D(s3d, 440, 300)
    started3D = true
  }).catch(() => {
    if (!running) return
    ctx = canvas.getContext('2d')
  })

  // UI info refreshed on each observer tick (and a slow interval for info
  // that changes without DOM mutations, e.g. model text).
  let sessionTitle: string | null = null
  let modelName: string | null = null
  let turnCount = 0
  let messageCount = 0

  // A completed thinking block (assistant round) consumes one work unit.
  const observer = new MutationObserver(() => {
    const running = document.querySelector('[data-variant="think"][data-state="running"]') !== null
    const busy = document.querySelector('[data-state="running"]') !== null
    const sleeping = document.hidden
    if (sleeping) state = 'asleep'
    else if (running) state = 'thinking'
    else if (busy) state = 'working'
    else state = 'idle'

    // Count rounds that settle to ok (a round completed).
    for (const settled of document.querySelectorAll('[data-variant="think"][data-state="ok"]')) {
      if (settled.getAttribute('data-counted') === 'true') continue
      settled.setAttribute('data-counted', 'true')
      const next = readInt(USED_KEY, used) + 1
      writeInt(USED_KEY, next)
      energyUsed = Math.min(next, budget)
    }

    // Refresh UI info (throttled by mutation bursts in practice).
    sessionTitle = readSessionTitle()
    const stats = readMessageStats()
    turnCount = stats.turns
    messageCount = stats.messages
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'class'] })

  const infoTimer = window.setInterval(() => {
    modelName = readModelName()
  }, 2000)

  let energyUsed = Math.min(used, budget)
  let rafId = 0
  let running = true
  // Click-to-rotate: spin the 3D figure once for a full surround view.
  let spinTo = 0
  let spinFrom = 0
  let spinStart = -1
  const SPIN_MS = 1400
  let lastBlink = 0
  let frame = 0

  // Icon-only by default: a compact glyph hints the agent state; the full
  // detail text (model / session) appears only after a click.
  const stateIcon: Record<CompanionState, string> = {
    thinking: '🤔', working: '⚙️', asleep: '💤', idle: '😊',
  }
  let statusExpanded = false
  const statusText = (): string => {
    if (!statusExpanded) return stateIcon[state]
    const stateText: Record<CompanionState, string> = {
      thinking: '思考中…', working: '工作中…', asleep: '休眠中 Zzz', idle: '待命中',
    }
    const parts = [stateText[state]]
    if (modelName !== null) parts.push(modelName)
    if (sessionTitle !== null) parts.push(sessionTitle)
    // <br> gives a guaranteed per-line break (plain \\n relies on white-space).
    return parts.map(p => escapeHtml(p)).join('<br>')
  }

  // ---- Full-screen roaming: walk along the viewport edges -------------------
  // The companion no longer hugs one corner; it patrols the screen perimeter so
  // it stays out of the centered content column (the conversation strip) while
  // being visibly "working" across the whole cockpit.
  const margin = 8
  // Diagonal roam: the figure moves with BOTH x and y changing (a slanting
  // path across the screen), so the radial depth scale naturally expands it
  // near the edges and shrinks it toward the centre — a real sense of
  // foreground/background (straight horizontal/vertical runs read flat).
  // y = distance from the viewport bottom (0 = progress bar hugging the floor).
  const walker = { x: window.innerWidth - 260, y: 60, vx: 0.7, vy: -0.5 }
  const updateWalker = (): void => {
    if (typeof dragging !== 'undefined' && (dragging || performance.now() < dragPauseUntil)) return
    const speed = state === 'asleep' ? 0 : state === 'working' ? 1.6 : 0.6
    if (speed === 0) return
    const extent = window.innerWidth - 260
    const vExtent = window.innerHeight - 320
    // Stepping slope: diagonal (both axes move every tick).
    walker.x += walker.vx * speed
    walker.y += walker.vy * speed
    if (walker.x >= extent) { walker.x = extent; walker.vx = -Math.abs(walker.vx) }
    else if (walker.x <= margin) { walker.x = margin; walker.vx = Math.abs(walker.vx) }
    if (walker.y >= vExtent) { walker.y = vExtent; walker.vy = -Math.abs(walker.vy) }
    else if (walker.y <= margin) { walker.y = margin; walker.vy = Math.abs(walker.vy) }
    root.style.left = `${walker.x}px`
    root.style.bottom = `${walker.y}px`
    root.style.right = 'auto'
    root.style.top = 'auto'

    // Radial depth-of-field (centre = far 1x, edges/corners = near 2x), scaled
    // from the BOTTOM so enlarging grows upward and the progress bar stays
    // pinned near the bottom edge instead of sinking below the viewport.
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const dx = walker.x + 110 - cx
    const dy = walker.y + 132 - cy
    const dist = Math.sqrt(dx * dx + dy * dy)
    const maxDist = Math.sqrt((window.innerWidth / 2) ** 2 + (window.innerHeight / 2) ** 2)
    const depthScale = 1 + (dist / maxDist) * 1.0   // 1.0 (centre) → 2.0 (corner)
    root.style.transformOrigin = 'bottom center'
    root.style.transform = `scale(${depthScale.toFixed(3)})`

    // Face the camera by walking direction: moving down the screen (vy < 0,
    // bottom distance shrinking = walking toward the user) faces the figure
    // forward; moving up (vy > 0, going away) turns its back. Skipped while a
    // click-spin is in progress so the surround rotation is not overridden.
    if (scene3D !== undefined && typeof spinStart !== 'undefined' && spinStart < 0) {
      scene3D.group.rotation.y = walker.vy > 0 ? Math.PI : 0
    }
  }
  const draw = (now: number): void => {
    if (!running) return
    // Roam the perimeter (unless asleep).
    updateWalker()
    const state3D = { thinking: state === 'thinking', working: state === 'working', asleep: state === 'asleep' }
    if (scene3D !== undefined) {
      // Apply a one-shot spin (full surround view) on top of state animation.
      if (spinStart >= 0) {
        const p = Math.min(1, (now - spinStart) / SPIN_MS)
        const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
        scene3D.group.rotation.y = spinFrom + (spinTo - spinFrom) * eased
        if (p >= 1) { spinStart = -1; scene3D.group.rotation.y = spinTo }
      }
      animateCompanion3D(scene3D, state3D, now / 1000)
    } else if (ctx !== null) {
      // Pixel fallback.
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      frame += 1
      const bob = state === 'asleep' ? 0 : Math.round(Math.sin(now / 400) * 1.5)
      const eyesClosed = state === 'asleep' || (state === 'idle' && now - lastBlink > 2600 && now - lastBlink < 2750)
      if (now - lastBlink > 2750) lastBlink = now
      let yOff = 0
      if (state === 'thinking') yOff = -Math.round(Math.abs(Math.sin(now / 300)) * 1.5)
      else if (state === 'working') yOff = Math.round(Math.sin(now / 160) * 1)
      for (let row = 0; row < SPRITE_H; row += 1) {
        const line = SPRITE[row]
        if (line === undefined) continue
        for (let col = 0; col < SPRITE_W; col += 1) {
          const ch = line[col]
          if (ch === undefined || ch === '.') continue
          const color = PALETTE[ch]
          if (color === undefined) continue
          if (ch === 'E' && eyesClosed) continue
          ctx.fillStyle = color
          ctx.fillRect(col * PX, (row + bob + yOff) * PX, PX, PX)
        }
      }
      if (eyesClosed) {
        ctx.fillStyle = '#1a1a2e'
        const eyeRow = 6
        for (const ex of [2, 5]) {
          ctx.fillRect(ex * PX, (eyeRow + bob + yOff) * PX + 2, PX * 2, 2)
        }
      }
    }

    statusEl.innerHTML = statusText()
    statusEl.title = statusEl.innerText
    const pct = Math.max(0, Math.round((1 - energyUsed / budget) * 100))
    energyFill.style.width = `${pct}%`
    energyFill.style.background = pct > 30
      ? 'linear-gradient(90deg,#34c759,#0a84ff)'
      : 'linear-gradient(90deg,#ff9f0a,#ff453a)'

    rafId = requestAnimationFrame(draw)
  }
  rafId = requestAnimationFrame(draw)

  // Click toggles a small info panel (budget / rounds / reset).
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;z-index:2147483001;display:none;flex-direction:column;gap:6px;min-width:200px;padding:10px;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 30px rgba(0,0,0,0.2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);'

  const refreshPanel = (): void => {
    const stateText: Record<CompanionState, string> = {
      thinking: '思考中…', working: '工作中…', asleep: '休眠中 Zzz', idle: '待命中',
    }
    const lines = [
      `状态：${stateText[state]}`,
      `会话：${sessionTitle ?? '未知'}`,
      `模型：${modelName ?? '未知'}`,
      `完成轮次：${turnCount}`,
      `消息块：${messageCount}`,
      `本月体力预算 ${budget} 轮 / 已用 ${energyUsed} 轮 / 剩余 ${Math.max(0, budget - energyUsed)} 轮`,
    ]
    panel.textContent = lines.join('\n')
    panel.appendChild(resetBtn)
  }
  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.textContent = '重置本月'
  resetBtn.style.cssText = 'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;padding:2px 8px;cursor:pointer;margin-top:2px;'
  resetBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    writeInt(USED_KEY, 0)
    energyUsed = 0
    refreshPanel()
  })
  document.body.appendChild(panel)

  let panelOpen = false
  const openPanel = (): void => {
    refreshPanel()
    const r = root.getBoundingClientRect()
    // Anchor the info panel beside the figure at the head-level line (same 45%
    // band as the speech bubble). Place on the open side so it never runs off
    // the viewport edge: right when there is room, otherwise left.
    const headY = r.y + r.height * 0.42
    const roomRight = window.innerWidth - (r.x + r.width + 8)
    const placeLeft = r.x - 8 - panel.offsetWidth > 4 && roomRight < 230
    if (placeLeft) {
      panel.style.left = `${Math.max(4, r.x - 8 - panel.offsetWidth)}px`
    } else {
      panel.style.left = `${Math.min(window.innerWidth - panel.offsetWidth - 8, r.x + r.width + 8)}px`
    }
    panel.style.top = `${Math.max(4, headY - Math.min(60, panel.offsetHeight / 2))}px`
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
    panel.style.display = 'flex'
  }
  // ---- User drag: allow the companion to be repositioned by hand -----------
  // Dragging temporarily pauses auto-roaming; the figure stays where dropped
  // until the next roam tick (it resumes after a short pause).
  let dragging = false
  let dragOffsetX = 0
  let dragOffsetY = 0
  let dragPauseUntil = 0
  root.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return
    dragging = true
    dragOffsetX = event.clientX - walker.x
    // walker.y is a BOTTOM offset; record how far the grab point is from the
    // figure's bottom edge in viewport-bottom space.
    dragOffsetY = walker.y - (window.innerHeight - event.clientY)
    root.setPointerCapture(event.pointerId)
    event.preventDefault()
  })
  root.addEventListener('pointermove', (event: PointerEvent) => {
    if (!dragging) return
    walker.x = Math.max(margin, Math.min(window.innerWidth - 260, event.clientX - dragOffsetX))
    const newBottom = (window.innerHeight - event.clientY) + dragOffsetY
    walker.y = Math.max(6, Math.min(window.innerHeight - 320, newBottom))
    root.style.left = `${walker.x}px`
    root.style.bottom = `${walker.y}px`
    root.style.right = 'auto'
    root.style.top = 'auto'
  })
  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    dragPauseUntil = performance.now() + 1500
    try { root.releasePointerCapture(event.pointerId) } catch { /* ignore */ }
  }
  root.addEventListener('pointerup', endDrag)
  root.addEventListener('pointercancel', endDrag)
  // Resume walking shortly after a drag so the companion stays alive.

  root.addEventListener('click', (event) => {
    event.stopPropagation()
    // Spin the 3D figure once for a full surround view.
    if (scene3D !== undefined) {
      spinFrom = scene3D.group.rotation.y
      spinTo = spinFrom + Math.PI * 2
      spinStart = performance.now()
    }
    // No info panel / step stats: the user wants only the head icon bubble and
    // none of the step/state text panels on the head. Click now just spins the
    // figure for a surround view and gives a small icon pulse.
    statusEl.style.transform = 'scale(1.35)'
    setTimeout(() => { statusEl.style.transform = '' }, 180)
    panelOpen = false
    panel.style.display = 'none'
  })
  document.addEventListener('click', () => {
    if (panelOpen) {
      panelOpen = false
      panel.style.display = 'none'
    }
  })

  return () => {
    running = false
    cancelAnimationFrame(rafId)
    observer.disconnect()
    clearInterval(infoTimer)
    root.remove()
    panel.remove()
  }
}

/**
 * Apple Glass composer enhancements — pure page-level presentation, driven
 * from this plugin's own DOM/CSS (never touching DSH internals):
 *
 * 1. Terminal-style composer: the message input's nearest rounded, filled
 *    container becomes a translucent frosted panel (blur + saturation) over
 *    the animated backdrop — the macOS Terminal look. The container is
 *    located structurally (textarea → closest rounded ancestor) and tagged
 *    with a `data-*` attribute so the CSS needs no DSH class names, which
 *    are hashed and change between builds.
 * 2. Auto-expanded thinking: every assistant `[data-variant="think"]`
 *    disclosure row is opened automatically, so the reasoning process is
 *    visible by default.
 *
 * A MutationObserver re-applies both after React re-renders (new sessions,
 * streaming turns). Everything is torn down on dispose.
 */

/** CSS for the terminal composer and any structural tags. */
const ENHANCE_CSS = `
[data-apple-glass-terminal] {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent) !important;
  backdrop-filter: blur(20px) saturate(1.5) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.5) !important;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12) !important;
  transition: background 0.3s ease, box-shadow 0.3s ease;
}
`

/**
 * Mark the message composer's frosted container: walk up from the textarea to
 * the first ancestor with a real background and a rounded corner.
 */
function markTerminal(): void {
  const input = document.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
  if (input === null) return
  let el: HTMLElement | null = input
  while (el !== null) {
    const cs = getComputedStyle(el)
    const hasFill = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'
    const rounded = parseFloat(cs.borderRadius || '0') >= 8
    if (hasFill && rounded) {
      el.dataset.appleGlassTerminal = 'true'
      return
    }
    el = el.parentElement
  }
}

/** Open every collapsed thinking disclosure row. */
function expandThinking(): void {
  for (const row of document.querySelectorAll<HTMLElement>(
    '[data-variant="think"] [data-disclosure-row][role="button"][aria-expanded="false"]',
  )) {
    row.click()
  }
}

/**
 * Apply the composer enhancements; returns the disposer removing them.
 */
export function applyComposerEnhancements(): () => void {
  const style = document.createElement('style')
  style.id = 'dsh-apple-glass-enhance'
  style.dataset.plugin = 'dsh-apple-glass-skin'
  style.textContent = ENHANCE_CSS
  document.head.appendChild(style)

  const refresh = (): void => {
    markTerminal()
    expandThinking()
  }
  const observer = new MutationObserver(refresh)
  observer.observe(document.body, { childList: true, subtree: true })
  refresh()

  return () => {
    observer.disconnect()
    style.remove()
    for (const el of document.querySelectorAll('[data-apple-glass-terminal]')) {
      el.removeAttribute('data-apple-glass-terminal')
    }
  }
}
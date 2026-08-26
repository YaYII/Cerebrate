/**
 * Immersive slim UI: hides text labels from secondary chrome so the workbench
 * reads as a cockpit rather than a traditional web app. Targets:
 *  - the Session-log download button keeps only its download icon,
 *  - the conversation block headers (Think / Code / Tool call) keep only
 *    their leading icon,
 *  - the view tabs (对话 / 轨迹) render as pure icons.
 *
 * Selectors are structural (data attributes / icon-presence), never CSS
 * module hashes, so a DSH upgrade that renames classes still matches.
 */

/** CSS text for the slim chrome rules. */
const SLIM_CSS = `
/* Session-log download: icon-only pill. */
button[class*='sessionLogButton'] {
  min-width: 32px;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 50%;
  gap: 0;
}
button[class*='sessionLogButton'] > span {
  display: none;
}
button[class*='sessionLogButton'] > svg {
  margin: 0;
}

/* View tabs (对话 / 轨迹): icon-only. */
[class*='tabs'] [role='tab'] {
  font-size: 0 !important;
  width: 32px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
[class*='tabs'] [role='tab']::before {
  font-size: 15px;
  line-height: 1;
}
/* 对话 tab → chat bubble icon. */
[class*='tabs'] [role='tab']:nth-child(1)::before {
  content: '💬';
}
/* 轨迹 tab → activity/path icon. */
[class*='tabs'] [role='tab']:nth-child(2)::before {
  content: '📈';
}
[class*='tabs'] [role='tab'][aria-selected='true'] {
  opacity: 1;
}
[class*='tabs'] [role='tab'][aria-selected='false'] {
  opacity: 0.55;
}

/* Conversation block titles (Think / Code / Tool call): hide the text,
   keep the leading icon + chevron so the row reads as a pure icon control. */
[data-variant] [data-disclosure-row] [class*='title'] {
  font-size: 0 !important;
  color: transparent !important;
}

/* Chat flow column: a uniform ~0.7 scrim over the whole conversation strip
   so the text column reads clearly while the side gutters keep the scene. */
[data-chat-flow] {
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 70%, var(--dsw-alias-bg-base));
  border-radius: 12px;
  backdrop-filter: blur(4px);
}

/* Conversation blocks: a soft scrim behind each message so the text floats
   over the scene like captions on a backdrop, while the side gutters keep
   showing the full animated scene. */
[data-variant] > [class*='root'] {
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 93%, var(--dsw-alias-bg-base));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 90%, transparent);
  border-radius: 10px;
  padding: 6px 12px;
  margin: 5px 0;
  backdrop-filter: blur(6px);
  box-shadow: 0 2px 18px rgba(0, 0, 0, 0.4);
}
`

/**
 * Apply the slim UI rules; returns the disposer removing them.
 */
export function applySlimUI(): () => void {
  const style = document.createElement('style')
  style.id = 'dsh-apple-glass-slim'
  style.dataset.plugin = 'dsh-apple-glass-skin'
  style.textContent = SLIM_CSS
  document.head.appendChild(style)

  // JS fallback: shrink text-bearing labels that CSS hash selectors miss.
  const hideTextLabels = (): void => {
    // Session log button text (structural: direct span sibling of svg).
    for (const btn of document.querySelectorAll<HTMLElement>('button')) {
      const span = btn.querySelector<HTMLElement>(':scope > span')
      const svg = btn.querySelector<HTMLElement>(':scope > svg')
      if (span !== null && svg !== null && (span.textContent || '').includes('Session log')) {
        span.style.display = 'none'
        btn.style.minWidth = '32px'
        btn.style.width = '32px'
        btn.style.padding = '0'
        btn.style.borderRadius = '50%'
      }
    }
  }
  hideTextLabels()
  const observer = new MutationObserver(hideTextLabels)
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    style.remove()
  }
}

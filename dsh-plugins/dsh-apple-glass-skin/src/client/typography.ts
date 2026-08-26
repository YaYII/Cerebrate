/**
 * Apple-style typography: loads the bundled MiSans typeface (a PingFang-like
 * open-source font shipped in this plugin) through @font-face rules and
 * applies the Apple font stack to the document. The rules live in a
 * plugin-owned <style> element so they are removed with the skin.
 */

/** CSS text for the MiSans @font-face rules and the Apple font stack. */
const TYPOGRAPHY_CSS = `
@font-face {
  font-family: 'MiSans';
  src: url('/dsh-apple-glass-skin/fonts/MiSans-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'MiSans';
  src: url('/dsh-apple-glass-skin/fonts/MiSans-Medium.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'MiSans';
  src: url('/dsh-apple-glass-skin/fonts/MiSans-Semibold.woff2') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
:root {
  --apple-font-family: 'MiSans', -apple-system, BlinkMacSystemFont, 'PingFang SC',
    'Noto Sans CJK SC', 'Noto Sans SC', 'Segoe UI', sans-serif;
}
html, body {
  font-family: var(--apple-font-family);
  font-feature-settings: 'tnum';
}
`

/** Inject the typography rules; returns the disposer removing them. */
export function injectTypography(): () => void {
  const style = document.createElement('style')
  style.id = 'dsh-apple-glass-typography'
  style.dataset.plugin = 'dsh-apple-glass-skin'
  style.textContent = TYPOGRAPHY_CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
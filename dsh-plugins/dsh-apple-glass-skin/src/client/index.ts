/**
 * dsh-apple-glass-skin — browser half (client plugin bundle).
 *
 * Registers the Tech-Space themes into the built-in ThemeRuntime, keeps a
 * fixed HUD backdrop in sync with the active skin, restores the saved skin
 * from localStorage (defaulting to the deep-space dark skin on first boot),
 * and mounts a skin picker row into the General settings section. The skin
 * choice persists in localStorage because the Host settings wire only
 * exposes an allowlisted set of namespaces to browser clients; localStorage
 * matches that boundary for a visual preference while surviving reloads on
 * the same origin.
 *
 * Skin application goes through ThemeRuntime.overrideTokens — a token-layer
 * stack that composes over whichever base theme is active and is untouched
 * by the Host preference adoption (setTheme on a third-party id is not
 * persisted by the Host and gets reset when the settings scope lands; the
 * override layer has no such lifecycle). The plugin also registers its
 * themes so the picker row and registry stay complete.
 *
 * Compatibility contract: this plugin uses only the documented ThemeRuntime
 * service surface (`register` / `overrideTokens` / `getTheme` /
 * `theme/change`), the settings item slot, and the locale plugin — no
 * component internals and no private tokens. It degrades to a warning
 * (never a crash) when a service is unavailable, so a future DSH upgrade
 * that reshapes the theme system disables the skin instead of breaking the
 * web UI.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the settings slot map and locale plugin Context merges.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SkinRowInjected } from './SkinRow.tsx'
import { SkinRow } from './SkinRow.tsx'
import { createSkinStore } from './skin-store.ts'
import { applyBackdrop, removeBackdrop } from './backdrop.ts'
import { DEFAULT_SKIN, findSkin, SKINS, type AppleSkin, type BackdropScene } from './skins.ts'
import { en, zh, type AppleSkinKey } from './locales.ts'
import { injectTypography } from './typography.ts'
import { applyComposerEnhancements } from './composer-enhance.ts'
import { mountCompanion } from './companion.ts'
import { applySlimUI } from './slim-ui.ts'

export type { SkinRowComponentProps, SkinRowInjected } from './SkinRow.tsx'
export type { SkinRowState } from './skin-store.ts'
export type { AppleSkin } from './skins.ts'
export type { AppleSkinKey } from './locales.ts'

/** Namespace owning this feature's settings-row copy. */
export const SETTINGS_NS = 'settings.appleGlass'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Tech-Space skin row's copy. */
    'settings.appleGlass': AppleSkinKey
  }
}

/** localStorage key holding the selected skin id. */
const STORAGE_KEY = 'dsh-apple-glass-skin:skin'
/** localStorage marker set once the user makes an explicit skin choice. */
const CHOSEN_KEY = 'dsh-apple-glass-skin:chosen'
/** Override-layer source id owned by this plugin. */
const OVERRIDE_SOURCE = 'dsh-apple-glass-skin'
/** localStorage key holding the backdrop scene id. */
const SCENE_KEY = 'dsh-apple-glass-skin:scene'
/** Default backdrop scene on first boot. */
const DEFAULT_SCENE: BackdropScene = 'space'

/** Read the persisted skin id (null on absence or storage failure). */
function readSavedSkin(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Persist the skin id (removes the entry for `system`). */
function writeSavedSkin(id: string): void {
  try {
    if (id === DEFAULT_SKIN) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Storage unavailable (private mode / quota) — the choice still applies
    // for this session; it just does not survive the next reload.
  }
}

/** Whether the user has ever made an explicit skin choice. */
function hasUserChosen(): boolean {
  try {
    return localStorage.getItem(CHOSEN_KEY) === '1'
  } catch {
    return false
  }
}

/** Mark that the user made an explicit skin choice (persisted). */
function markUserChosen(): void {
  try {
    localStorage.setItem(CHOSEN_KEY, '1')
  } catch {
    // Non-fatal: the default-skin bootstrap still works for this session.
  }
}

/**
 * Resolve the skin to apply on boot.
 * - A previously saved skin id wins.
 * - The user picking "follow system" is remembered via the chosen marker;
 *   with no saved id that stays a no-op (system appearance).
 * - A brand-new visitor (no saved id, no chosen marker) gets the deep-space
 *   dark Tech-Space skin automatically so the plugin is visible out of the
 *   box; the choice is persisted so reloads keep it.
 */
function resolveBootSkin(): string | null {
  const saved = readSavedSkin()
  if (saved !== null && SKINS.some(s => s.id === saved)) return saved
  if (hasUserChosen()) return null
  const boot = SKINS[0]
  if (boot === undefined) return null
  writeSavedSkin(boot.id)
  return boot.id
}

/** Read the persisted backdrop scene (defaults to space). */
function readScene(): BackdropScene {
  try {
    const raw = localStorage.getItem(SCENE_KEY)
    if (raw === 'city' || raw === 'ocean' || raw === 'space' || raw === 'matrix') return raw
  } catch {
    // storage unavailable — default scene still works for this session
  }
  return DEFAULT_SCENE
}

/** Persist the backdrop scene. */
function writeScene(scene: BackdropScene): void {
  try {
    localStorage.setItem(SCENE_KEY, scene)
  } catch {
    // Non-fatal: the choice still applies for this session.
  }
}

/** Services consumed through the documented theme/slots/locale seams. */
export const inject = ['theme', 'slots', 'locale']

/**
 * Client plugin body: register the Tech-Space themes, keep the backdrop in
 * sync, restore (or bootstrap) the skin, and register the settings row.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  // Typography applies whenever the plugin is active, independent of the
  // selected theme, so the typeface stays stable while toggling skins.
  ctx.effect(injectTypography, 'dsh-apple-glass-skin: typography')
  ctx.effect(applyComposerEnhancements, 'dsh-apple-glass-skin: composer enhancements')
  ctx.effect(mountCompanion, 'dsh-apple-glass-skin: companion')
  ctx.effect(applySlimUI, 'dsh-apple-glass-skin: slim UI')

  // Theme registration is best-effort: a future DSH that reshapes or drops
  // ThemeRuntime must disable the skin, not break the web UI.
  const disposers = SKINS.map((skin) => {
    try {
      return ctx.theme.register({
        id: skin.id,
        colorScheme: skin.colorScheme,
        tokens: skin.tokens,
      })
    } catch (error) {
      console.warn(`[dsh-apple-glass-skin] skip theme "${skin.id}":`, error)
      return () => {}
    }
  })
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-apple-glass-skin: theme registration')

  // ---- Skin application: token override layer ------------------------------
  // setTheme on a third-party id is not persisted by the Host (the settings
  // scope only accepts built-in preferences) and the preference adoption that
  // follows settings load resets it — so the skin is applied as an override
  // layer instead, which stacks over the active base theme and survives every
  // Host round-trip. The layer is { light, dark } keyed; a skin's concrete
  // palette is scheme-invariant (both slots repeat the same value).
  /**
   * Reflect the active skin's color scheme on the document: `data-ds-dark-theme`
   * plus `color-scheme` so native chrome (scrollbars, form controls, code
   * highlighting) follows the skin. The built-in presenter drives this from the
   * resolved base theme's colorScheme, which stays `light` under an override
   * layer — so this plugin owns the marker for its skins. Removed for the
   * light skin and for `follow system` so the built-in appearance rules.
   */
  const syncSchemeMarker = (skin: AppleSkin | null): void => {
    const body = document.body
    if (skin === null || skin.colorScheme !== 'dark') {
      body.removeAttribute('data-ds-dark-theme')
      document.documentElement.style.colorScheme = 'light'
      return
    }
    body.setAttribute('data-ds-dark-theme', '')
    document.documentElement.style.colorScheme = 'dark'
  }
  let disposeOverrides: (() => void) | null = null
  let currentSkin: string | null = null
  let currentScene: BackdropScene = readScene()
  const store = createSkinStore()
  let bound: BoundActions<typeof store> | undefined
  const syncStore = (): void => {
    // Reassert the scheme marker on every theme change: the built-in presenter
    // drives it from the base theme's colorScheme (light under our override
    // layer), so a settings-scope adoption or scheme flip would clear it.
    // Defer the DOM write so it lands after the presenter's synchronous apply
    // in the same change batch (listener order is registration order).
    const active = currentSkin === null ? undefined : findSkin(currentSkin)
    const marker = active ?? null
    if (marker !== null) {
      queueMicrotask(() => syncSchemeMarker(marker))
    }
    bound?.sync(currentSkin ?? DEFAULT_SKIN, currentScene, ctx.theme.getTheme().revision)
  }
  ctx.on('theme/change', syncStore)
  const applySkin = (skinId: string | null): void => {
    disposeOverrides?.()
    disposeOverrides = null
    currentSkin = skinId
    const skin = skinId === null ? undefined : findSkin(skinId)
    if (skin === undefined) {
      syncSchemeMarker(null)
      removeBackdrop()
      syncStore()
      return
    }
    const overrides: Record<string, { light: string; dark: string }> = {}
    for (const [name, value] of Object.entries(skin.tokens)) {
      overrides[name] = { light: value, dark: value }
    }
    try {
      disposeOverrides = ctx.theme.overrideTokens(OVERRIDE_SOURCE, overrides)
      applyBackdrop(skin, currentScene)
      syncSchemeMarker(skin)
      syncStore()
    } catch (error) {
      console.warn('[dsh-apple-glass-skin] skin application failed:', error)
      syncSchemeMarker(null)
      removeBackdrop()
      syncStore()
    }
  }

  // Bootstrap the boot skin immediately; no reassert loop is needed because
  // the override layer has no preference lifecycle to race.
  const bootSkin = resolveBootSkin()
  applySkin(bootSkin)
  ctx.effect(() => () => {
    disposeOverrides?.()
    disposeOverrides = null
    removeBackdrop()
  }, 'dsh-apple-glass-skin: skin cleanup')

  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'dsh-apple-glass-skin: settings row dictionaries')

  const injected = (actions: BoundActions<typeof store>): SkinRowInjected => {
    bound = actions
    // Re-sync from the getter so no event is lost between registration and
    // first render (the store's revision guard drops stale duplicates).
    syncStore()
    return {
      setSkin: (id) => {
        applySkin(id === DEFAULT_SKIN ? null : id)
        writeSavedSkin(id)
        markUserChosen()
      },
      setScene: (scene) => {
        currentScene = scene
        writeScene(scene)
        const skin = currentSkin === null ? undefined : findSkin(currentSkin)
        if (skin !== undefined) applyBackdrop(skin, scene)
        syncStore()
      },
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'apple-glass-skin',
    order: 30,
    store,
    locale: SETTINGS_NS,
    inject: injected,
  }, SkinRow))
}

# dsh-apple-glass-skin

Apple glass-morphism skin for the DeepSeek Harness (DSH) web UI: translucent
frosted panels over a macOS-style gradient backdrop, in light and dark
variants. A standalone DSH plugin package (host loader entry + browser client
bundle) installed through the standard `dsh plugin` channel — no core
modification.

## What it does

- Registers two third-party themes into DSH's built-in ThemeRuntime:
  - `apple-glass` — light: frosty blue / lavender / blush gradient backdrop,
    translucent white surfaces, Apple blue accent (`#0071e3`).
  - `apple-glass-dark` — dark: deep-space blue / violet gradient backdrop,
    translucent graphite surfaces, Apple blue accent (`#0a84ff`).
- Keeps a fixed gradient backdrop layer behind the app; the translucent
  surface tokens let it show through — the frosted-glass effect.
- Adds a skin picker row to **Settings → General** (three cards: follow
  system / glass light / glass dark), with live preview swatches.
- Persists the choice in `localStorage` per browser and restores it on boot.

## How it works

- **Host half** (`lib/index.js`): a no-op loader entry; the feature lives in
  the browser half.
- **Browser half** (`lib/client.js`): a `dsh.client` bundle served at
  `/plugins/dsh-apple-glass-skin/client.js`, loaded by `dsh-client-modules`
  through the package's `dsh.client` declaration — the same shape as the
  shipped `ui-*` packages.
- The skin choice persists in `localStorage`: DSH's Host settings wire only
  exposes an allowlisted set of namespaces to browser clients, so a
  third-party namespace would answer `settings-not-exposed`; localStorage
  matches that boundary for a visual preference while surviving reloads.

## Compatibility contract

The plugin uses only the documented, stable seams — the ThemeRuntime service
surface (`register` / `setTheme` / `getTheme` / `theme/change`), the
`settings.general.item` slot, and the locale plugin. It degrades to a warning
(never a crash) when a service is unavailable, so a future DSH upgrade that
reshapes the theme system disables the skin instead of breaking the web UI.

Design choices that keep it resilient:

- **Public API only** — no component internals, no private tokens, no
  stylesheet patches over app components.
- **Namespaced theme ids** (`apple-glass` / `apple-glass-dark`) that cannot
  collide with built-in or other third-party themes.
- **Token-driven palette** — surfaces are translucent `--dsw-alias-*` values;
  labels and states stay opaque for readability. No `var()` indirection, so
  contrast is self-contained.
- **Own DOM for the backdrop** — a `position: fixed; z-index: -1` gradient
  layer that never touches app components; it is removed when a non-Apple
  theme becomes active.

## Install

```sh
dsh plugin --profile web add -w /path/to/dsh-apple-glass-skin
```

Then restart the web server (`dsh web`, or restart your service manager
unit). Open **Settings → General** and pick a skin.

> The `-w` flag is required: every profile ships a `pnpm-workspace.yaml`, so
> pnpm treats the profile directory as a workspace root and refuses a bare
> `add` with `ERR_PNPM_ADDING_TO_ROOT`.

## Development

```sh
pnpm install          # installs dev dependencies (tsdown, vitest, jsdom, ...)
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest (skin catalog, locales, backdrop DOM)
pnpm build            # tsdown: lib/index.js + lib/invariant.js + lib/client.js
```

The client bundle is a CJS artifact stamped for the shell's
`window.__ModuleLoader__.load` module table; platform modules (react, cordis,
client service packages) stay external and the shell answers them at runtime.
After editing, rebuild and restart the web server (bundle content is
re-hashed and served with a new `rev`; loader entries are rescanned at boot).

## Layout

```
src/index.ts           host half (no-op loader entry)
src/invariant.ts       invariant companion (no runtime invariant)
src/client/index.ts    browser half: theme registration, backdrop sync,
                       saved-skin restore, settings row
src/client/skins.ts    Apple Glass skin catalog (tokens + gradients)
src/client/backdrop.ts fixed gradient backdrop layer
src/client/SkinRow.tsx skin picker row (inline styles, no stylesheet)
src/client/skin-store.ts  settings-row store (defineStore mirror)
src/client/locales.ts  zh / en copy
tests/                 vitest suites
```

## License

MIT

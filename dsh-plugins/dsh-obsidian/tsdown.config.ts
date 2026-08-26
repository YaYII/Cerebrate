/**
 * Standalone tsdown config for dsh-obsidian. Mirrors the repository shape:
 * a node ESM lib half. The plugin exposes only a host loader entry (tools),
 * no browser/client bundle, so there is only the node ESM output.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-obsidian',
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

/**
 * Standalone tsdown config for @deepseek-ai/dsh-memory-cerebrate.
 * Node ESM lib half; no browser/client bundle.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-memory-cerebrate',
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

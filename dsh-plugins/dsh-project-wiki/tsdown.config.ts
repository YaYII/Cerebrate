/**
 * Standalone tsdown config for dsh-project-wiki. Node ESM host plugin half.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-project-wiki',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

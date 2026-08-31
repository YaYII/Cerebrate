/**
 * dsh-web-search 的独立 tsdown 配置：node ESM 库半体。
 * 插件只暴露 host 加载入口（工具），因此只有 node ESM 输出。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-web-search',
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

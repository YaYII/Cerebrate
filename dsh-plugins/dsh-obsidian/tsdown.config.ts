/**
 * dsh-obsidian 的独立 tsdown 配置。镜像仓库形态：node ESM 库半体。
 * 插件只暴露 host 加载入口（工具），无浏览器/client 包，因此只有 node ESM 输出。
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

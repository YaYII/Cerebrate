/**
 * dsh-mail-bridge 的独立 tsdown 配置：node ESM 库半体。
 *
 * imapflow 与 mailparser 放在 devDependencies 中，构建期被内联进产物——
 * 部署侧按绝对路径加载单个 lib/index.js，不需要为该插件准备 node_modules。
 * 该约束由 scripts/check-bundle.mjs 在门禁里自动把关。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-mail-bridge',
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

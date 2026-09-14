/**
 * dsh-email 的独立 tsdown 配置：node ESM 库半体。
 * 插件只暴露 host 加载入口（email_send 工具），因此只有 node ESM 输出。
 * nodemailer 放在 devDependencies 中，构建期被内联进产物——部署侧只需
 * 加载 lib/index.js 一个文件，与同仓库其他插件一致（零运行时 node_modules）。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-email',
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

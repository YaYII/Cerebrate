/**
 * dsh-typesafe 的独立 tsdown 配置：node ESM 库半体。
 *
 * 插件只暴露 host 加载入口（ts_* 工具），因此只有 node ESM 输出。
 * 本插件**零运行时依赖**：判定客户端直接调用 TypeSafe HTTP API（与官方 SDK 同一接口），
 * 不引入第三方包，从根上避免 SDK 版本漂移——部署侧只需加载 lib/index.js 一个文件。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-typesafe',
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

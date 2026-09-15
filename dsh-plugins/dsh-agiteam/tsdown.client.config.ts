/**
 * dsh-agiteam Client 打包配置 —— 独立于 harness workspace 的 client bundle 构建。
 *
 * 模仿 harness `packages/client/tsdown.client.ts` 的 clientConfig 核心：
 *  1. banner/footer 产出 `window.__ModuleLoader__.load({id, factory})` 格式；
 *  2. react/react-dom/@deepseek-ai/cordis 走 externals（运行时由浏览器模块表提供）；
 *  3. `*.css?inline` 内联为文本并注入 <style> 标签（插件生命周期内）。
 *
 * 与 pipeline-kernel 的 build:client（tsc + tsdown）同构：
 *  先 tsc -p tsconfig.client.json 产 lib/types/client/，再 tsdown 打包 lib/client.js。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = (JSON.parse(readFileSync(resolvePath(ROOT, 'package.json'), 'utf8')) as { name: string }).name

/** 运行时由浏览器模块表（PLATFORM_MODULES）提供的 externals。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
]

/** CSS 内联虚拟前缀（避开 tsdown 自身的 css 管线）。 */
const CSS_INLINE_PREFIX = '\0dsh-css-inline:'
const CSS_INLINE_SUFFIX = '.mjs'

/** 生成一个插件拥有的样式注入模块（?inline 语义：导出文本 + 注入 style 标签）。 */
function styleInjectionModule(id: string, fileId: string, css: string): string {
  const tagId = `${id}/${fileId.split('/').pop()}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    'export default css;',
  ].join('\n')
}

/** 内联 CSS 的 tsdown 插件（处理 `*.css?inline` 导入）。 */
function inlineCssPlugin(id: string) {
  return {
    name: 'dsh-agiteam-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css?inline')) return null
      const abs = importer !== undefined
        ? resolvePath(dirname(importer), source.replace(/\?inline$/, ''))
        : source.replace(/\?inline$/, '')
      return CSS_INLINE_PREFIX + abs + CSS_INLINE_SUFFIX
    },
    load(virtualId: string) {
      if (!virtualId.startsWith(CSS_INLINE_PREFIX)) return null
      const fileId = virtualId.slice(CSS_INLINE_PREFIX.length, -CSS_INLINE_SUFFIX.length)
      const css = readFileSync(fileId, 'utf8')
      return styleInjectionModule(id, fileId, css)
    },
  }
}

/** client bundle 的 tsdown 配置（产出 lib/client.js）。 */
export default {
  name: 'dsh-agiteam/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    // 请求的模块表 specifier 保持 import（运行时由浏览器提供），其余全部内联
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.includes(specifier),
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.includes(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [inlineCssPlugin(PACKAGE_NAME)],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

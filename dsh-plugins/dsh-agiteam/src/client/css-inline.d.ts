/**
 * CSS ?inline 导入的类型声明（构建时由 tsdown 内联插件处理）。
 */
declare module '*.css?inline' {
  /** 编译后的 CSS 文本。 */
  const css: string
  export default css
}

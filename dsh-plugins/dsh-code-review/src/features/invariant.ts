/**
 * `@deepseek-ai/dsh-code-review` 包自有的不变量伴侣。
 * @module @deepseek-ai/dsh-code-review/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-code-review'

/** Cordis 伴侣插件名。 */
export const name = 'dsh-code-review-invariant'
/** 注册包所有权前需要的服务。 */
export const inject = ['invariants']

/**
 * 无运行时不变式：本包不拥有任何持久事件流或可变数据关系——它产出的每个
 * 产物（`.code-review/*.json` / `*.md`）都是限定在审查项目内的纯文件系统
 * 输出，其工具是确定性子进程运行器。集成面由针对夹具项目的测试验证。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的 invariant 伴侣。
 * @param ctx - 携带 invariant 服务的 Cordis 上下文。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

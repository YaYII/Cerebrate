/**
 * `@deepseek-ai/dsh-obsidian` 包自有的不变量伴侣。
 * @module @deepseek-ai/dsh-obsidian/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-obsidian'

/** Cordis 伴侣插件名。 */
export const name = 'dsh-obsidian-invariant'
/** 注册包所有权前需要的服务。 */
export const inject = ['invariants']

/**
 * 无运行时不变式：本包不拥有任何持久事件流或可变数据关系——它产出的每个
 * 值都是外部 REST API（Obsidian Local REST / Brain 服务端）的响应，其引导
 * 注入是插件来源的用户消息。集成面由针对真实/mock 端点的测试验证。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的 invariant 伴侣。
 * @param ctx - 携带 invariant 服务的 Cordis 上下文。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

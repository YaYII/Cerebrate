/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-cerebrate`.
 * @module @deepseek-ai/dsh-memory-cerebrate/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-cerebrate'

/** Cordis companion plugin name. */
export const name = 'memory-cerebrate-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no durable event stream or mutable
 * data relation — every value it emits is a response envelope from the external
 * Brain Server, and its guidance injection is a plugin-sourced user message.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

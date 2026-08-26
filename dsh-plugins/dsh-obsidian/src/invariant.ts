/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-obsidian`.
 * @module @deepseek-ai/dsh-obsidian/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-obsidian'

/** Cordis companion plugin name. */
export const name = 'dsh-obsidian-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no durable event stream or mutable
 * data relation — every value it emits is a response from an external REST
 * API (Obsidian Local REST / Brain Server), and its guidance injection is a
 * plugin-sourced user message. The integration surface is verified by tests
 * against live/mocked endpoints instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

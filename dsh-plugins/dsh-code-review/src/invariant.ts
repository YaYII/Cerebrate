/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-code-review`.
 * @module @deepseek-ai/dsh-code-review/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-code-review'

/** Cordis companion plugin name. */
export const name = 'dsh-code-review-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no durable event stream or mutable
 * data relation — every artifact it emits (`.code-review/*.json` / `*.md`) is
 * plain filesystem output scoped to the reviewed project, and its tools are
 * deterministic subprocess runners. The integration surface is verified by
 * tests against fixture projects instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

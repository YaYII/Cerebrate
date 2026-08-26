/**
 * dsh-apple-glass-skin — package invariant companion.
 *
 * No runtime invariant: the skin is a browser-only presentation plugin. All
 * its behavior lives in the client bundle and is verified by the client
 * lifecycle (theme registration, settings row, backdrop mount) rather than
 * a Host event/data relationship this package owns.
 */

/** No-op companion entry required by the dsh package layout. */
export function apply() {}
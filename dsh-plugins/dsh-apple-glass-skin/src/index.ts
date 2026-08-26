/**
 * dsh-apple-glass-skin — host half.
 *
 * Host loader entry that serves the bundled MiSans font files over the web
 * server (`/dsh-apple-glass-skin/fonts/…`) and the 3D companion model
 * (`/dsh-apple-glass-skin/glb/…`), so the browser half can load the
 * Apple-style typeface and the written-real chibi figure without any core
 * modification. DSH's `/plugins` route only serves `client.js`, so the
 * assets get their own prefix route here — still entirely inside this
 * plugin's own bundle and files.
 *
 * The rest of the feature lives in the browser half (`./client`), picked up
 * by dsh-client-modules through the package's `dsh.client` declaration. The
 * skin choice persists in localStorage: the Host settings wire only exposes
 * an allowlisted set of namespaces to browser clients, so localStorage
 * matches that boundary for visual preferences.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Bundled font files in the plugin package's assets/fonts directory. */
const FONT_DIR = fileURLToPath(new URL('../assets/fonts/', import.meta.url))

/** Bundled 3D model files in the plugin package's assets/glb directory. */
const GLB_DIR = fileURLToPath(new URL('../assets/glb/', import.meta.url))

/** Route name → MIME type for the served 3D model files. */
const GLB_TYPES: Record<string, string> = {
  'Meshy_AI_Chibi_Figure_0820031320_texture.glb': 'model/gltf-binary',
}

/** Route name → MIME type for the served font files. */
const FONT_TYPES: Record<string, string> = {
  'MiSans-Regular.woff2': 'font/woff2',
  'MiSans-Medium.woff2': 'font/woff2',
  'MiSans-Semibold.woff2': 'font/woff2',
}

/** Serve one bundled font file; 404 for anything else under the prefix. */
async function serveFont(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  const name = pathname.split('/').pop() ?? ''
  const type = FONT_TYPES[name]
  if (type === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const body = await readFile(join(FONT_DIR, name))
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'public, max-age=86400',
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/** Serve one bundled glb model file; 404 for anything else under the prefix. */
async function serveGlb(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  const name = pathname.split('/').pop() ?? ''
  const type = GLB_TYPES[name]
  if (type === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const body = await readFile(join(GLB_DIR, name))
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'public, max-age=86400',
      'content-length': String(body.length),
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * Host loader entry: register the font route when the web server is composed.
 * @param ctx - host cordis context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-apple-glass-skin/fonts',
        handler: serveFont,
      }),
      'dsh-apple-glass-skin: bundled fonts',
    )
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-apple-glass-skin/glb',
        handler: serveGlb,
      }),
      'dsh-apple-glass-skin: bundled 3d model',
    )
  })
}
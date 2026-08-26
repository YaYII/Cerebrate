/**
 * Obsidian team-knowledge-base client for DeepSeek Harness.
 *
 * Talks to a local Obsidian vault over the Local REST API community plugin
 * (secure HTTPS on 127.0.0.1:27124 by default, self-signed cert) and
 * registers native `obsidian_*` and `knowledge_*` tools, so the team
 * knowledge base participates in the agent loop directly, plugin-only —
 * no MCP anywhere in the path.
 *
 * Two knowledge layers, one plugin:
 *   1. obsidian_* tools  — the vault file layer (read/write/search/patch/
 *                          list/command/open on plain Markdown files).
 *   2. knowledge_* tools — the Brain Server authoritative team knowledge
 *                          base (vector-semantic search + tiered write:
 *                          ordinary knowledge writable by any logged-in
 *                          agent, policy/authoritative docs admin-only).
 *
 * The guidance injection folds a plugin-sourced instructions message into
 * the first agent step explaining the memory vs knowledge distinction and
 * the concrete tools to use for each.
 *
 * @module @deepseek-ai/dsh-obsidian
 */

import os from 'node:os'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin identifier, used as the cordis entry name and injection source tag. */
export const name = 'dsh-obsidian'
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Obsidian Local REST API base URL (defaults to the secure port). */
  baseUrl: string
  /** Environment-variable name holding the Obsidian API key. */
  apiKeyEnv: string
  /** Local file holding the Obsidian API key (JSON {"apiKey": ...} or bare text). */
  apiKeyFile: string
  /** Allow HTTPS with a self-signed certificate (Local REST API default). */
  tlsRejectUnauthorized: boolean
  /** Brain Server base URL for the knowledge_* tools. */
  brainUrl: string
  /** Environment-variable name holding the Brain Server master/user token. */
  brainTokenEnv: string
  /** Local file holding the Brain Server token (JSON {"token": ...} or bare text). */
  brainTokenFile: string
  /** Default user id sent with brain knowledge writes. */
  user: string
  /** Default agent id recorded on brain knowledge operations. */
  agentId: string
  /** Whether the knowledge-first guidance message is injected on the first step. */
  injectGuidance: boolean
  /** Auto-start a local Obsidian when the REST API is unreachable (self-heal). */
  autoStart: boolean
  /** Absolute path to the Obsidian executable used for auto-start. */
  obsidianBin: string
  /** How long to wait for the auto-started Obsidian to serve the API, ms. */
  launchTimeoutMs: number
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('https://127.0.0.1:27124'),
  apiKeyEnv: z.string().default('OBSIDIAN_API_KEY'),
  apiKeyFile: z.string().default('~/.obsidian/api-key'),
  tlsRejectUnauthorized: z.boolean().default(false),
  brainUrl: z.string().default('http://127.0.0.1:8765'),
  brainTokenEnv: z.string().default('CEREBRATE_SERVER_TOKEN'),
  brainTokenFile: z.string().default('~/.cerebrate/token'),
  user: z.string().default('yangying'),
  agentId: z.string().default('dsh'),
  injectGuidance: z.boolean().default(true),
  autoStart: z.boolean().default(true),
  obsidianBin: z.string().default(os.homedir() + '/bin/obsidian-deb/opt/Obsidian/obsidian'),
  launchTimeoutMs: z.number().default(45000),
})

/** One v5-protocol envelope from the Brain Server. */
interface Envelope {
  status: string
  data?: unknown
  error?: { code?: number | string; message?: string }
}

/** A generic JSON value map that survives lossless JSON round-trips. */
type JsonMap = Record<string, JsonValue>

/** Parsed response of an Obsidian REST call. */
interface ObsidianResult {
  /** HTTP status code. */
  status: number
  /** Parsed body (JSON when applicable, else raw text). */
  body: unknown
  /** Raw response text. */
  raw: string
}

/**
 * Resolve a secret from an environment variable first, then a local file
 * (JSON envelope with the named key, or bare text). Shared shape for both
 * the Obsidian API key and the Brain Server token.
 */
async function resolveSecret(envName: string, file: string, jsonKey: string): Promise<string> {
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const path = file.replace(/^~/, os.homedir())
  try {
    const raw = (await readFile(path, 'utf8')).trim()
    if (raw.length === 0) return ''
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && jsonKey in parsed) {
        const v = (parsed as Record<string, unknown>)[jsonKey]
        return typeof v === 'string' ? v : ''
      }
    } catch {
      // Not JSON — treat the whole line as the secret.
    }
    return raw
  } catch {
    return ''
  }
}

/** Build the concrete request per config (https vs http base URL). */
function requestBuilder(baseUrl: string, rejectUnauthorized: boolean) {
  const mod = baseUrl.startsWith('https') ? https : http
  return () => mod
}

/**
 * Perform one HTTP request to the Obsidian Local REST API (or any base URL).
 * Resolves with status + parsed body; network failures degrade to a
 * structured error so the model sees a reason instead of a thrown exception.
 */
function rawRequest(
  baseUrl: string,
  rejectUnauthorized: boolean,
  method: string,
  apiPath: string,
  headers: Record<string, string>,
  bodyText?: string,
): Promise<ObsidianResult> {
  const url = new URL(baseUrl.replace(/\/+$/, '') + apiPath)
  return new Promise<ObsidianResult>((resolve) => {
    const mod = url.protocol === 'https:' ? https : http
    // 直接传 url.pathname 避免二次编码：URL 对象再序列化时会把已编码的
    // %XX 转成 %25XX（中文笔记名路径会因此 404）；pathname 保留原始编码。
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || undefined,
      protocol: url.protocol,
      path: url.pathname + url.search,
      method,
      headers: { ...headers, ...(bodyText !== undefined ? { 'Content-Length': Buffer.byteLength(bodyText) } : {}) },
      rejectUnauthorized,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: unknown = raw
        try { body = JSON.parse(raw) } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode ?? 0, body, raw })
      })
    })
    req.on('error', (error) => {
      const reason = error instanceof Error ? error.message : String(error)
      resolve({ status: 503, body: { error: { message: `无法连接 ${baseUrl}: ${reason}` } }, raw: '' })
    })
    if (bodyText !== undefined) req.write(bodyText)
    req.end()
  })
}

/**
 * Resolve the Obsidian API key for the plugin in the Brave-mode sense: env
 * then file. Empty when neither source carries one (the tools then fail with
 * guidance instead of crashing).
 */
async function resolveApiKey(config: Config): Promise<string> {
  return resolveSecret(config.apiKeyEnv, config.apiKeyFile, 'apiKey')
}

/** Call the Obsidian REST API; injects the Bearer key and JSON headers. */
async function obsidianCall(
  config: Config,
  method: string,
  apiPath: string,
  bodyText?: string,
  extraHeaders: Record<string, string> = {},
): Promise<ObsidianResult> {
  const key = await resolveApiKey(config)
  const mod = requestBuilder(config.baseUrl, config.tlsRejectUnauthorized)
  if (mod() === https) {
    // no-op; requestBuilder is just a discriminator for clarity
  }
  return rawRequest(config.baseUrl, config.tlsRejectUnauthorized, method, apiPath, {
    ...(key.length > 0 ? { Authorization: `Bearer ${key}` } : {}),
    ...(bodyText !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...extraHeaders,
  }, bodyText)
}

/** Human-readable summarizer for non-2xx Obsidian responses. */
function obsidianError(result: ObsidianResult, op: string): JsonMap {
  if (typeof result.body === 'object' && result.body !== null && 'message' in result.body) {
    const m = (result.body as Record<string, unknown>).message
    return { ok: false, op, status: result.status, error: String(m) }
  }
  return { ok: false, op, status: result.status, error: result.raw.slice(0, 300) }
}

/** Check availability of the Obsidian REST API (no auth needed for /). */
async function obsidianStatus(config: Config): Promise<JsonMap> {
  const result = await rawRequest(config.baseUrl, config.tlsRejectUnauthorized, 'GET', '/', {}, undefined)
  const key = await resolveApiKey(config)
  if (result.status >= 200 && result.status < 300) {
    return { ok: true, baseUrl: config.baseUrl, authenticated: key.length > 0 }
  }
  return { ok: false, baseUrl: config.baseUrl, status: result.status, error: result.raw.slice(0, 200) }
}

/**
 * Coerce an arbitrary parsed body into a lossless JSON value. JSON.parse
 * output is already a JSON value, so this is a type-level bridge for
 * `unknown` bodies; null/undefined fall back to an object so renderers
 * always see a valid record.
 */
function toJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return { empty: true }
  return value as JsonValue
}

/** Render one tool result to the model as pretty-printed JSON text. */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** Tool call presentation card. */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/** Concatenate a path into a vault-relative URL-encoded path (with /vault/ prefix). */
function vaultPath(path: string): string {
  const segments = path.split('/').map(encodeURIComponent).join('/')
  return segments.length === 0 ? '/vault/' : '/vault/' + segments
}

// ── Brain Server knowledge tools ──────────────────────────────────────

/** Call one Brain Server endpoint and return its v5 envelope. */
async function brainCall(config: Config, method: string, apiPath: string, body?: unknown): Promise<JsonMap> {
  const token = await resolveSecret(config.brainTokenEnv, config.brainTokenFile, 'token')
  const url = `${config.brainUrl.replace(/\/$/, '')}${apiPath}`
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token.length > 0 ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    try {
      return JSON.parse(text) as JsonMap
    } catch {
      return { status: 'error', error: { code: response.status, message: text } }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 'error', error: { code: 503, message: `无法连接脑虫服务 ${url}: ${reason}` } }
  }
}

// ── Knowledge-first guidance ───────────────────────────────────────────

/**
 * Guidance folded into the first agent step. States the memory-vs-knowledge
 * split and the concrete tools, so the model reaches for the vault file
 * layer for documents and the brain knowledge base for authoritative
 * retrieval.
 */
const GUIDANCE = [
  '【团队知识库】本会话已连接两个团队知识载体：',
  '1. Obsidian 知识库（obsidian_* 工具）：纯 Markdown 文件库，用于读写/搜索团队文档、设计、归档。',
  '2. Brain 团队权威知识库（knowledge_search / knowledge_store）：向量语义检索权威知识。',
  '',
  '【记忆与知识库是两个概念】记忆（cerebrate_*）= 过程经验/决策/踩坑；知识库 = 权威文档/策略/项目事实。',
  '解决当前问题前，先 obsidian_search 检索文件知识库；仍缺再用 knowledge_search 查权威知识库；',
  '都无命中再独立解决。解决问题后，把结论用 obsidian_write 落到知识库文档；',
  '确属团队级权威知识再 knowledge_store 沉淀（策略/权威文档仅管理员可写）。',
].join('\n')

/** Plugin source tag carried by this package's injected messages. */
const PLUGIN_TAG = 'dsh-obsidian'

/**
 * Probe whether the Obsidian Local REST API is reachable (no API key needed for /).
 */
async function probeObsidian(config: Config): Promise<boolean> {
  try {
    const result = await rawRequest(config.baseUrl, config.tlsRejectUnauthorized, 'GET', '/', {}, undefined)
    return result.status >= 200 && result.status < 300
  } catch {
    return false
  }
}

/**
 * Self-heal: launch a local Obsidian so the team knowledge-base file layer
 * stays available. Called on plugin apply when the REST API is unreachable,
 * so this plugin owns its dependency instead of depending on a manually
 * configured systemd service or a session terminal that a restart may kill.
 *
 * The child is detached (own process group) and the parent waits up to
 * launchTimeoutMs for the API to come up; any failure degrades to a warning
 * (never a crash) so the plugin still loads for the Brain knowledge tools.
 */
async function ensureObsidianRunning(config: Config): Promise<void> {
  if (!config.autoStart) return
  // Fast path: REST already reachable.
  if (await probeObsidian(config)) return
  // An Obsidian main process (or its Electron singleton lock) already exists:
  // never spawn a second instance — wait for the existing one to serve the API.
  const instanceExists = obsidianProcessExists(config.obsidianBin) || obsidianSingletonLockExists()
  if (instanceExists) {
    console.log('[dsh-obsidian] Obsidian instance already present; waiting for REST API (no new spawn)')
    const waiting = Date.now() + config.launchTimeoutMs
    while (Date.now() < waiting) {
      await new Promise(r => setTimeout(r, 1500))
      if (await probeObsidian(config)) {
        console.log('[dsh-obsidian] Obsidian REST API is up')
        return
      }
    }
    console.warn('[dsh-obsidian] existing Obsidian instance did not serve the API within', config.launchTimeoutMs, 'ms')
    return
  }
  if (!existsSync(config.obsidianBin)) {
    console.warn('[dsh-obsidian] Obsidian unreachable and binary not found:', config.obsidianBin)
    return
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: process.env.DISPLAY ?? ':0',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? 'wayland-0',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${os.userInfo().uid ?? ''}`,
    HOME: os.homedir(),
  }
  // Resolve the X11 auth cookie present in a running Wayland/Xorg session.
  const runDir = `/run/user/${os.userInfo().uid ?? ''}`
  let xauth = process.env.XAUTHORITY ?? ''
  if (!xauth || !existsSync(xauth)) {
    try {
      const match = readdirSync(runDir).find(n => n.startsWith('.mutter-Xwaylandauth'))
      if (match) xauth = `${runDir}/${match}`
    } catch { /* no run dir */ }
  }
  if (!xauth) {
    console.warn('[dsh-obsidian] no XAUTHORITY found; launching headless is not possible')
    return
  }
  env.XAUTHORITY = xauth
  console.log('[dsh-obsidian] starting Obsidian:', config.obsidianBin)
  const child = spawn(config.obsidianBin, ['--no-sandbox'], {
    env,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  // Wait for the REST API to come up.
  const deadline = Date.now() + config.launchTimeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    if (await probeObsidian(config)) {
      console.log('[dsh-obsidian] Obsidian REST API is up')
      return
    }
  }
  console.warn('[dsh-obsidian] Obsidian did not serve the API within', config.launchTimeoutMs, 'ms')
}
/** Whether the guidance already lives in the session's visible surface. */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.events[seq]
    return event?.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === PLUGIN_TAG
  })
}

/**
 * Register the `obsidian_*` and `knowledge_*` tool set and, when enabled,
 * the knowledge-first guidance injection on the first agent step.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - plugin configuration.
 */

/**
 * Whether an Obsidian instance is already running on this machine. Electron
 * is single-instance per user-data-dir so spawning a second main process when
 * one already exists is wasteful (and can leave Multi-process race). Detected
 * via (a) a matching main-process command line and (b) the SingletonLock file
 * Electron drops in the user-data dir. Either present => instance exists.
 */
function obsidianProcessExists(binPath: string): boolean {
  try {
    const list = readdirSync('/proc').filter(n => /^\d+$/.test(n))
    if (list.includes(String(process.pid))) list.splice(list.indexOf(String(process.pid)), 1)
    for (const pid of list) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
        // Precise main-process match: the executable's own argv[0] is our
        // obsidian binary (a lone token/path), not an arbitrary mention of
        // "obsidian" somewhere in the command line (e.g. a node script that
        // happens to reference the path). Electron subrenders carry --type=
        // and are skipped; only the root main process is the singleton owner.
        const argv0 = cmd.split(' ')[0] ?? ''
        const isMain = !cmd.includes('--type=')
        const exact = argv0 === binPath || argv0 === binPath.split('/').pop()
        if (exact && isMain) return true
      } catch { /* pid vanished */ }
    }
  } catch { /* procfs unavailable */ }
  return false
}

/**
 * Check the Electron singleton marker Obsidian drops in its user-data dir.
 * The lock name embeds the hostname; we match by the Singleton prefix.
 */
function obsidianSingletonLockExists(): boolean {
  const conf = `${os.homedir()}/.config/obsidian`
  try {
    return readdirSync(conf).some(n => n.startsWith('Singleton'))
  } catch {
    return false
  }
}
export function apply(ctx: Context, config: Config): void {
  // Self-heal the dependency: if the Obsidian REST API is not reachable,
  // launch a local instance. Fire-and-forget so tool registration never
  // blocks on a slow spawn; failures degrade to a warning.
  void ensureObsidianRunning(config)

  const tools = {
    status: defineTool({
      name: 'obsidian_status',
      description: '检查 Obsidian Local REST API 连接状态（无需认证）；返回 ok/baseUrl/是否已配置 API key。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: () => obsidianStatus(config),
      presentCall: args => presentCall('Obsidian connection status', args),
    }),
    list: defineTool({
      name: 'obsidian_list',
      description: '列出 Obsidian vault 中指定目录下的文件/子目录（默认根目录）。返回相对路径列表。',
      parameters: {
        path: { type: 'string', description: 'vault 内目录路径，如 "" 或 "团队知识库"', default: '' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const p = (args.path ?? '').trim()
        const dir = p.length === 0 ? '/' : vaultPath(p) + '/'
        const result = await obsidianCall(config, 'GET', dir, undefined)
        if (result.status < 200 || result.status >= 300) return obsidianError(result, 'obsidian_list')
        return { ok: true, path: p || '/', files: toJson(result.body) }
      },
      presentCall: args => presentCall('List vault directory', args),
    }),
    read: defineTool({
      name: 'obsidian_read',
      description: '读取 Obsidian vault 中一个 Markdown 文件的内容。返回文件全文（含 frontmatter）。',
      parameters: {
        path: { type: 'string', required: true, description: 'vault 相对路径，如 "团队知识库/入门指南.md"' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const result = await obsidianCall(config, 'GET', vaultPath(String(args.path)), undefined)
        if (result.status < 200 || result.status >= 300) return obsidianError(result, 'obsidian_read')
        return { ok: true, path: String(args.path), title: String(args.path).split('/').pop() ?? '', content: result.raw }
      },
      presentCall: args => presentCall('Read vault note', args),
    }),
    write: defineTool({
      name: 'obsidian_write',
      description: '在 Obsidian vault 写入（覆盖）一个 Markdown 文件。若路径不存在会创建（含上级目录）。',
      parameters: {
        path: { type: 'string', required: true, description: 'vault 相对路径，如 "团队知识库/xxx.md"' },
        content: { type: 'string', required: true, description: 'Markdown 全文' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const result = await obsidianCall(config, 'PUT', vaultPath(String(args.path)), String(args.content), {
          'Content-Type': 'text/markdown',
        })
        if (result.status < 200 || result.status >= 300) return obsidianError(result, 'obsidian_write')
        return { ok: true, path: String(args.path) }
      },
      presentCall: args => presentCall('Write vault note', args),
    }),
    append: defineTool({
      name: 'obsidian_append',
      description: '在 Obsidian vault 的一个 Markdown 文件末尾追加内容（不破坏既有文本）。',
      parameters: {
        path: { type: 'string', required: true, description: 'vault 相对路径' },
        content: { type: 'string', required: true, description: '要追加的 Markdown 文本' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        // v5.1.0 的 PATCH targetType 枚举为 heading/block/frontmatter；
        // 用 heading + 空 target 表示追加到文档末尾（targetType:'content' 会 400）。
        const result = await obsidianCall(config, 'PATCH', vaultPath(String(args.path)), JSON.stringify({
          targetType: 'heading',
          operation: 'append',
          target: [],
          content: String(args.content),
        }))
        if (result.status < 200 || result.status >= 300) return obsidianError(result, 'obsidian_append')
        return { ok: true, path: String(args.path) }
      },
      presentCall: args => presentCall('Append to vault note', args),
    }),
    search: defineTool({
      name: 'obsidian_search',
      description: '全文搜索 Obsidian vault。POST /search/simple/（query 作为 URL 参数），返回命中文档、评分与上下文片段。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词' },
        contextLength: { type: 'integer', description: '每个命中的上下文长度（字符）', default: 200 },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const q = String(args.query)
        const cl = Math.max(0, Number(args.contextLength ?? 200))
        const qs = '?query=' + encodeURIComponent(q) + '&contextLength=' + cl
        const result = await obsidianCall(config, 'POST', '/search/simple/' + qs, undefined)
        if (result.status < 200 || result.status >= 300) return obsidianError(result, 'obsidian_search')
        return { ok: true, query: q, results: toJson(result.body) }
      },
      presentCall: args => presentCall('Search vault', args),
    }),
    commands: defineTool({
      name: 'obsidian_commands',
      description: '列出 Obsidian 中可用的命令（command palette 等价物）。返回命令 id 列表。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async () => {
        const result = await obsidianCall(config, 'GET', '/commands/', undefined)
        if (result.status < 200 || result.status >= 300) return obsidianError(result, 'obsidian_commands')
        return { ok: true, commands: toJson(result.body) }
      },
      presentCall: () => presentCall('List Obsidian commands', {}),
    }),
    commandRun: defineTool({
      name: 'obsidian_command_run',
      description: '执行一个 Obsidian 命令（如 open 笔记、创建日记、执行模板）。需要先通过 obsidian_commands 查询命令 id。',
      parameters: {
        commandId: { type: 'string', required: true, description: '命令 id，如 "app:open-vault"' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const id = String(args.commandId)
        const result = await obsidianCall(config, 'POST', '/commands/' + encodeURIComponent(id) + '/', undefined)
        if (result.status < 200 || result.status >= 300) return obsidianError(result, 'obsidian_command_run')
        return { ok: true, commandId: id }
      },
      presentCall: args => presentCall('Run Obsidian command', args),
    }),
    open: defineTool({
      name: 'obsidian_open',
      description: '在 Obsidian UI 中打开指定笔记（唤起窗口并聚焦）。',
      parameters: {
        path: { type: 'string', required: true, description: 'vault 相对路径，如 "团队知识库/入门指南.md"' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const result = await obsidianCall(config, 'POST', '/open/' + encodeURIComponent(String(args.path)), undefined)
        if (result.status < 200 || result.status >= 300) return obsidianError(result, 'obsidian_open')
        return { ok: true, path: String(args.path) }
      },
      presentCall: args => presentCall('Open note in Obsidian', args),
    }),
    knowledgeSearch: defineTool({
      name: 'knowledge_search',
      description: '搜索 Brain 团队权威知识库（向量语义检索）。返回文档标题/内容片段/主题/score。',
      parameters: {
        query: { type: 'string', required: true, description: '检索问题/关键词' },
        topic: { type: 'string', description: '主题过滤（可选）' },
        project_id: { type: 'string', description: '项目ID（可选）' },
        scope: { type: 'string', enum: ['', 'general', 'project', 'all'], description: '知识范围' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const q = String(args.query)
        const params = new URLSearchParams({ q })
        if (args.topic) params.set('topic', String(args.topic))
        if (args.project_id) params.set('project_id', String(args.project_id))
        if (args.scope) params.set('scope', String(args.scope))
        return brainCall(config, 'GET', '/v1/knowledge?' + params.toString())
      },
      presentCall: args => presentCall('Search team knowledge', args),
    }),
    knowledgeStore: defineTool({
      name: 'knowledge_store',
      description: '把一篇文档存入 Brain 团队权威知识库。普通知识（默认）任何 agent 可写；policy/权威标记 require admin token。',
      parameters: {
        title: { type: 'string', required: true, description: '文档标题' },
        content: { type: 'string', required: true, description: '文档正文（Markdown）' },
        topics: { type: 'string', description: '逗号分隔主题标签' },
        project_id: { type: 'string', description: '项目ID（可选）' },
        scope: { type: 'string', enum: ['', 'general', 'project'], description: '知识范围' },
        is_policy: { type: 'boolean', description: '标记为策略文档（需 admin token）', default: false },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const topics = Array.isArray(args.topics)
          ? args.topics.map(String)
          : String(args.topics ?? '').split(',').map(s => s.trim()).filter(Boolean)
        return brainCall(config, 'POST', '/v1/knowledge', {
          title: String(args.title),
          content: String(args.content),
          topics,
          project_id: String(args.project_id ?? ''),
          scope: String(args.scope ?? ''),
          is_policy: Boolean(args.is_policy),
          agent_id: config.agentId,
          author: config.user,
          source: 'dsh-obsidian',
        })
      },
      presentCall: args => presentCall('Store team knowledge', args),
    }),
  }
  for (const tool of Object.values(tools)) ctx.tools.register(tool)

  if (config.injectGuidance) {
    ctx.on('agent/pre-step', async (
      { agent, messages, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (guidanceAlreadyInjected(agent)) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text', text: GUIDANCE }],
        source: { kind: 'plugin', plugin: PLUGIN_TAG, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}
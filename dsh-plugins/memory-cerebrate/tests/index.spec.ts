import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { Config, apply, inject, name } from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** Wire a fake fetch and return the recorded requests. */
function mockFetch(): { requests: { url: string; init: RequestInit }[] } {
  const captured: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    captured.push({ url: u, init: init ?? {} })
    return new Response(JSON.stringify({ status: 'ok', data: { hello: 'world' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
  return { requests: captured }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ Config, apply, inject, name }, {
    baseUrl: 'http://127.0.0.1:8765',
    tokenEnv: 'CEREBRATE_SERVER_TOKEN',
    tokenFile: '/nonexistent/token.json',
    user: 'yangying',
    agentId: 'dsh',
    injectMemoryGuidance: true,
  })
  return ctx
}

function execute(ctx: Context, toolName: string, args: unknown, callId = 1) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${callId}`),
    name: toolName,
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dsh-memory-cerebrate', () => {
  it('registers the nine cerebrate_* tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual([
      'cerebrate_detail',
      'cerebrate_propose',
      'cerebrate_query',
      'cerebrate_recall',
      'cerebrate_remember',
      'cerebrate_search',
      'cerebrate_sense',
      'cerebrate_stats',
      'cerebrate_timeline',
    ])
  })

  it('calls GET /v1/sense with the Bearer token from the environment', async () => {
    const { requests } = mockFetch()
    vi.stubEnv('CEREBRATE_SERVER_TOKEN', 'tok-123')
    const ctx = await setup()
    const result = await execute(ctx, 'cerebrate_sense', {})
    expect(text(result)).toContain('"hello": "world"')
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.url).toBe('http://127.0.0.1:8765/v1/sense')
    expect((request.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
  })

  it('posts a search request carrying the configured agent id and defaults', async () => {
    const { requests } = mockFetch()
    const ctx = await setup()
    const result = await execute(ctx, 'cerebrate_search', { query: 'dsh 插件' })
    expect(text(result)).toContain('"hello": "world"')
    const request = requests[0]!
    expect(request.url).toBe('http://127.0.0.1:8765/v1/search')
    const body = JSON.parse(request.init.body as string) as Record<string, unknown>
    expect(body.query).toBe('dsh 插件')
    expect(body.agent_id).toBe('dsh')
    expect(body.scope).toBe('')
    expect(body.mode).toBe('hybrid')
    expect(body.limit).toBe(20)
  })

  it('renders an error envelope when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const ctx = await setup()
    const result = await execute(ctx, 'cerebrate_sense', {})
    expect(text(result)).toContain('无法连接脑虫服务')
  })

  it('rejects invalid arguments through the registry schema', async () => {
    mockFetch()
    const ctx = await setup()
    const missing = await execute(ctx, 'cerebrate_search', {})
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('missing required property "query"')
    const wrongType = await execute(ctx, 'cerebrate_detail', { ids: 'not-an-array' })
    expect(wrongType.isError).toBe(true)
  })
})

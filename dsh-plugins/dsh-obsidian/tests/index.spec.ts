import { describe, expect, it, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { Config, apply, inject, name } from '../src/index.ts'

const testSignal = new AbortController().signal

/** Local fake HTTP server capturing requests and returning canned JSON. */
async function fakeObsidianServer() {
  const http = await import('node:http')
  let requests: { method: string; url: string; headers: Record<string, string>; body: string }[] = []
  let handler: (req: import('node:http').IncomingMessage) => { status: number; json: unknown } = () => ({ status: 200, json: { files: [] } })
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: (req.headers as Record<string, string>), body })
      const out = handler(req)
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return {
    port: address.port,
    requests: () => requests,
    setHandler: (h: typeof handler) => { handler = h },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function setup(config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ Config, apply, inject, name }, {
    baseUrl: 'http://127.0.0.1:1', // 会被覆盖为 fake 端口
    apiKeyEnv: 'OBSIDIAN_API_KEY',
    apiKeyFile: '/nonexistent/api-key',
    tlsRejectUnauthorized: false,
    brainUrl: 'http://127.0.0.1:1',
    brainTokenEnv: 'CEREBRATE_SERVER_TOKEN',
    brainTokenFile: '/nonexistent/token',
    user: 'yangying',
    agentId: 'dsh',
    injectGuidance: true,
    autoStart: false, // 测试环境不真实拉 Obsidian
    obsidianBin: '/nonexistent/obsidian',
    launchTimeoutMs: 100,
    ...config,
  })
  return ctx
}

function execute(ctx: Context, toolName: string, args: unknown, callId = 1) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`call-${callId}`),
    name: toolName,
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

afterEach(() => {
  vi.unstubAllEnvs?.()
  vi.unstubAllGlobals?.()
})

describe('dsh-obsidian', () => {
  it('registers the twelve plugin tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(s => s.name).sort()
    expect(names).toEqual([
      'knowledge_search',
      'knowledge_store',
      'obsidian_append',
      'obsidian_command_run',
      'obsidian_commands',
      'obsidian_list',
      'obsidian_open',
      'obsidian_read',
      'obsidian_search',
      'obsidian_status',
      'obsidian_write',
    ].sort())
  })

  it('obsidian_status reports ok against a live fake server', async () => {
    const fake = await fakeObsidianServer()
    try {
      const ctx = await setup({ baseUrl: `http://127.0.0.1:${fake.port}` })
      const result = await execute(ctx, 'obsidian_status', {})
      expect(text(result)).toContain('"ok": true')
    } finally {
      await fake.close()
    }
  })

  it('obsidian_read fetches the vault path with the Bearer key and decodes path', async () => {
    const fake = await fakeObsidianServer()
    fake.setHandler(() => ({ status: 200, json: { body: '# hello' } }))
    try {
      vi.stubEnv?.('OBSIDIAN_API_KEY', 'k-123')
      const ctx = await setup({ baseUrl: `http://127.0.0.1:${fake.port}` })
      const result = await execute(ctx, 'obsidian_read', { path: '团队知识库/入门.md' })
      expect(text(result)).toContain('入门.md')
      const req = fake.requests()[0]!
      expect(req.headers.authorization).toBe('Bearer k-123')
      expect(decodeURIComponent(req.url)).toContain('团队知识库/入门.md')
      // 必须带 /vault/ 前缀：Obsidian REST 文件路径挂在 /vault/ 下（回归：曾缺失导致 404）
      expect(req.url).toMatch(/^\/vault\//)
    } finally {
      await fake.close()
    }
  })

  it('obsidian_write PUTs content as markdown', async () => {
    const fake = await fakeObsidianServer()
    fake.setHandler(() => ({ status: 200, json: { ok: true } }))
    try {
      vi.stubEnv?.('OBSIDIAN_API_KEY', 'k-123')
      const ctx = await setup({ baseUrl: `http://127.0.0.1:${fake.port}` })
      await execute(ctx, 'obsidian_write', { path: 'a/b.md', content: '# title\nbody' })
      const req = fake.requests()[0]!
      expect(req.method).toBe('PUT')
      expect(req.url).toBe('/vault/a/b.md')
      expect(req.body).toContain('# title')
    } finally {
      await fake.close()
    }
  })

  it('obsidian_search POSTs /search/simple/ with a URL query param', async () => {
    const fake = await fakeObsidianServer()
    fake.setHandler(() => ({ status: 200, json: [{ filename: 'x.md', score: 1 }] }))
    try {
      vi.stubEnv?.('OBSIDIAN_API_KEY', 'k-123')
      const ctx = await setup({ baseUrl: `http://127.0.0.1:${fake.port}` })
      await execute(ctx, 'obsidian_search', { query: '区块链', contextLength: 150 })
      const req = fake.requests()[0]!
      expect(req.method).toBe('POST')
      expect(req.url).toContain('/search/simple/')
      expect(req.url).toContain('query=')
      expect(req.url).toContain('contextLength=150')
    } finally {
      await fake.close()
    }
  })

  it('knowledge_store POSTs to /v1/knowledge with fields', async () => {
    const fake = await fakeObsidianServer()
    fake.setHandler(() => ({ status: 200, json: { status: 'ok', data: { doc_id: 'abc' } } }))
    try {
      vi.stubEnv?.('CEREBRATE_SERVER_TOKEN', 'tok-1')
      const ctx = await setup({ brainUrl: `http://127.0.0.1:${fake.port}` })
      const result = await execute(ctx, 'knowledge_store', {
        title: 'T', content: 'C', topics: 'a,b', project_id: 'p', scope: 'project', is_policy: false,
      })
      expect(text(result)).toContain('"doc_id": "abc"')
      const req = fake.requests()[0]!
      expect(req.method).toBe('POST')
      expect(req.url).toBe('/v1/knowledge')
      const body = JSON.parse(req.body)
      expect(body.title).toBe('T')
      expect(body.agent_id).toBe('dsh')
      expect(body.is_policy).toBe(false)
    } finally {
      await fake.close()
    }
  })
})
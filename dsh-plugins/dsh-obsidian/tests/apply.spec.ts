/**
 * dsh-obsidian 装配层测试：mock ctx 捕获注册的工具，直接驱动 execute。
 *
 * apply() 注册 11 个工具（obsidian_* / knowledge_*）；测试通过捕获的
 * defineTool 对象逐个调用 execute，配合本地 HTTP server 实测全部工具
 * 的成功/失败分支。
 * @module @deepseek-ai/dsh-obsidian
 */

import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'

/** 启动本地 HTTP server（mock Obsidian/Brain 端点）。 */
function startServer(handler: (url: string, method: string, body: string) => { status: number; body: string }): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const r = handler(req.url ?? '/', req.method ?? 'GET', Buffer.concat(chunks).toString('utf8'))
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(r.body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ port, close: () => new Promise<void>(done => server.close(() => done())) })
    })
  })
}

/** 捕获 apply 注册的工具并返回（key → tool）。 */
function captureTools(config: Config): Record<string, { execute: (args?: Record<string, unknown>) => Promise<Record<string, unknown>> }> {
  const registered: Record<string, { execute: (args?: Record<string, unknown>) => Promise<Record<string, unknown>> }> = {}
  const ctx = {
    tools: { register: (tool: { name: string; execute: (args?: Record<string, unknown>) => Promise<Record<string, unknown>> }) => { registered[tool.name] = tool } },
    on: () => {},
  } as unknown as Context
  apply(ctx, config)
  return registered
}

/** 基础配置：autoStart=false 避免自愈启动副作用。 */
function baseConfig(port: number): Config {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnv: 'DSH_TEST_OBS_KEY',
    apiKeyFile: '/nonexistent/key-file',
    tlsRejectUnauthorized: false,
    brainUrl: `http://127.0.0.1:${port}`,
    brainTokenEnv: 'DSH_TEST_BRAIN_TOKEN',
    brainTokenFile: '/nonexistent/token-file',
    user: 'tester',
    agentId: 'test-agent',
    injectGuidance: false,
    knowledgePolicy: '',
    autoStart: false,
    obsidianBin: '/nonexistent/bin',
    launchTimeoutMs: 100,
  }
}

const servers: Array<{ port: number; close: () => Promise<void> }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  delete process.env.DSH_TEST_OBS_KEY
  delete process.env.DSH_TEST_BRAIN_TOKEN
})

describe('apply 注册与 obsidian_* 工具 execute', () => {
  it('注册全部 11 个工具', async () => {
    const s = await startServer(() => ({ status: 200, body: '{}' }))
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    expect(Object.keys(tools).sort()).toEqual([
      'knowledge_search', 'knowledge_store',
      'obsidian_append', 'obsidian_command_run', 'obsidian_commands', 'obsidian_list',
      'obsidian_open', 'obsidian_read', 'obsidian_search', 'obsidian_status', 'obsidian_write',
    ])
  })

  it('obsidian_status 成功与失败', async () => {
    const ok = await startServer(() => ({ status: 200, body: 'ok' }))
    servers.push(ok)
    const okTools = captureTools(baseConfig(ok.port))
    expect((await okTools.obsidian_status!.execute({})).ok).toBe(true)
    const bad = await startServer(() => ({ status: 500, body: 'down' }))
    servers.push(bad)
    const badTools = captureTools(baseConfig(bad.port))
    expect((await badTools.obsidian_status!.execute({})).ok).toBe(false)
  })

  it('obsidian_list 根目录与子目录', async () => {
    const s = await startServer((url) => {
      if (url === '/') return { status: 200, body: JSON.stringify(['a.md']) }
      if (url === '/vault/%E5%9B%A2%E9%98%9F%E7%9F%A5%E8%AF%86%E5%BA%93/') return { status: 200, body: JSON.stringify(['b.md']) }
      return { status: 404, body: 'x' }
    })
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    const root = await tools.obsidian_list!.execute({})
    expect(root.ok).toBe(true)
    const sub = await tools.obsidian_list!.execute({ path: '团队知识库' })
    expect(sub.ok).toBe(true)
  })

  it('obsidian_read 成功返回全文', async () => {
    const s = await startServer((url) => {
      if (url === '/vault/readme.md') return { status: 200, body: '# 标题\n正文' }
      return { status: 404, body: 'not found' }
    })
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    const ok = await tools.obsidian_read!.execute({ path: 'readme.md' })
    expect(ok.ok).toBe(true)
    expect(ok.content).toContain('# 标题')
    const missing = await tools.obsidian_read!.execute({ path: 'nope.md' })
    expect(missing.ok).toBe(false)
  })

  it('obsidian_write / append / search / commands / command_run / open', async () => {
    const s = await startServer((url, method, body) => {
      if (url === '/vault/a.md' && method === 'PUT') return { status: 200, body: '{}' }
      if (url === '/vault/a.md' && method === 'PATCH') return { status: 200, body: '{}' }
      if (url.startsWith('/search/simple/')) return { status: 200, body: JSON.stringify([{ title: 't', score: 1 }]) }
      if (url === '/commands/') return { status: 200, body: JSON.stringify(['app:open-vault']) }
      if (url === '/commands/app%3Aopen-vault/') return { status: 200, body: '{}' }
      if (url.startsWith('/open/')) return { status: 200, body: '{}' }
      return { status: 404, body: 'x' }
    })
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    const write = await tools.obsidian_write!.execute({ path: 'a.md', content: '# x' })
    expect(write.ok).toBe(true)
    const append = await tools.obsidian_append!.execute({ path: 'a.md', content: '更多' })
    expect(append.ok).toBe(true)
    const search = await tools.obsidian_search!.execute({ query: '知识' })
    expect(search.ok).toBe(true)
    expect(search.query).toBe('知识')
    const commands = await tools.obsidian_commands!.execute({})
    expect(commands.ok).toBe(true)
    const run = await tools.obsidian_command_run!.execute({ commandId: 'app:open-vault' })
    expect(run.ok).toBe(true)
    const open = await tools.obsidian_open!.execute({ path: 'a.md' })
    expect(open.ok).toBe(true)
  })

  it('obsidian_write 非 2xx → 结构化错误', async () => {
    const s = await startServer(() => ({ status: 403, body: JSON.stringify({ message: '无权限' }) }))
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    const r = await tools.obsidian_write!.execute({ path: 'a.md', content: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('无权限')
  })
})

describe('knowledge_* 工具 execute', () => {
  it('knowledge_search 透传查询参数并返回 v5 信封', async () => {
    const s = await startServer((url) => {
      expect(url).toContain('/v1/knowledge?q=')
      expect(url).toContain('topic=dev')
      return { status: 200, body: JSON.stringify({ status: 'ok', data: { docs: [] } }) }
    })
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    const r = await tools.knowledge_search!.execute({ query: '架构', topic: 'dev' })
    expect(r.status).toBe('ok')
  })

  it('knowledge_store 提交文档（含 topics 数组与作者信息）', async () => {
    const s = await startServer((_url, _method, body) => {
      const parsed = JSON.parse(body)
      expect(parsed.title).toBe('架构规范')
      expect(parsed.topics).toEqual(['架构', '规范'])
      expect(parsed.agent_id).toBe('test-agent')
      expect(parsed.author).toBe('tester')
      expect(parsed.is_policy).toBe(false)
      return { status: 200, body: JSON.stringify({ status: 'ok', data: { id: '1' } }) }
    })
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    const r = await tools.knowledge_store!.execute({ title: '架构规范', content: '正文', topics: '架构,规范' })
    expect(r.status).toBe('ok')
  })

  it('knowledge_store is_policy=true 透传', async () => {
    const s = await startServer((_u, _m, body) => {
      expect(JSON.parse(body).is_policy).toBe(true)
      return { status: 200, body: JSON.stringify({ status: 'ok' }) }
    })
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    const r = await tools.knowledge_store!.execute({ title: 't', content: 'c', is_policy: true })
    expect(r.status).toBe('ok')
  })

  it('knowledge_search 支持 project_id/scope 参数透传', async () => {
    const s = await startServer((url) => {
      expect(url).toContain('project_id=wiki')
      expect(url).toContain('scope=project')
      return { status: 200, body: JSON.stringify({ status: 'ok' }) }
    })
    servers.push(s)
    const tools = captureTools(baseConfig(s.port))
    const r = await tools.knowledge_search!.execute({ query: 'q', project_id: 'wiki', scope: 'project' })
    expect(r.status).toBe('ok')
  })
})

describe('guidance 注入（agent/pre-step）', () => {
  it('injectGuidance=true 时在首步注入引导消息', async () => {
    const s = await startServer(() => ({ status: 200, body: '{}' }))
    servers.push(s)
    let handler: ((args: Record<string, unknown>, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>) | undefined
    const ctx = {
      tools: { register: () => {} },
      on: (event: string, fn: unknown) => { if (event === 'agent/pre-step') handler = fn as never },
    } as unknown as Context
    const config = { ...baseConfig(s.port), injectGuidance: true }
    apply(ctx, config)
    expect(handler).toBeDefined()
    // 最小 agent 模拟：surface 无节点 → 判定未注入 → 插入引导
    const agent = {
      session: { surface: { nodes: [] }, events: {} },
    }
    const decision = await handler!({
      agent,
      messages: [],
      step: 1,
      signal: { throwIfAborted: () => {} },
    }, async () => ({ kind: 'enter', messages: [{ type: 'text', text: '原始' }] }))
    const entered = decision as { kind: string; messages: unknown[] }
    expect(entered.kind).toBe('enter')
    expect(entered.messages.length).toBeGreaterThan(1) // 引导消息被插入
    const injected = JSON.stringify(entered.messages)
    expect(injected).toContain('【团队知识库】')
  })

  it('引导已注入时不重复插入', async () => {
    const s = await startServer(() => ({ status: 200, body: '{}' }))
    servers.push(s)
    let handler: ((args: Record<string, unknown>, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>) | undefined
    const ctx = {
      tools: { register: () => {} },
      on: (event: string, fn: unknown) => { if (event === 'agent/pre-step') handler = fn as never },
    } as unknown as Context
    apply(ctx, { ...baseConfig(s.port), injectGuidance: true })
    // surface 已有本插件注入消息 → guidanceAlreadyInjected 返回 true → 原样返回
    const agent = {
      session: {
        surface: { nodes: [0] },
        events: { 0: { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-obsidian' } } } },
      },
    }
    const decision = await handler!({
      agent,
      messages: [],
      step: 2,
      signal: { throwIfAborted: () => {} },
    }, async () => ({ kind: 'enter', messages: [{ type: 'text', text: '原始' }] }))
    const entered = decision as { kind: string; messages: unknown[] }
    expect(entered.messages).toHaveLength(1) // 无引导插入
  })
})

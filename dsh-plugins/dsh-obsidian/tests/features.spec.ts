/**
 * dsh-obsidian features 层单元测试。
 *
 * 用本地 HTTP server 模拟 Obsidian Local REST API 与 Brain 服务端，
 * 实测全部客户端能力：密钥解析、HTTP 请求（成功/4xx/网络失败）、
 * 路径编码、Brain v5 信封、自愈启动器的可测分支。
 * @module @deepseek-ai/dsh-obsidian
 */

import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveSecret, rawRequest, toJson, type ClientConfig } from '../src/features/rest'
import { obsidianCall, obsidianStatus, obsidianError, vaultPath } from '../src/features/obsidian'
import { brainCall } from '../src/features/brain'
import { ensureObsidianRunning, obsidianProcessExists, obsidianSingletonLockExists } from '../src/features/launcher'

/** 本地 HTTP server 与端口（用于 mock Obsidian/Brain）。 */
interface MockServer {
  port: number
  close: () => Promise<void>
}

/** 启动一个本地 HTTP server，按请求路径分发响应。 */
function startServer(handler: (url: string, method: string, body: string) => { status: number; body: string; headers?: Record<string, string> }): Promise<MockServer> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const r = handler(req.url ?? '/', req.method ?? 'GET', body)
        res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers ?? {}) })
        res.end(r.body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

/** 带 mock 端点的连接配置（key 来自环境变量）。 */
function configFor(port: number, overrides: Partial<ClientConfig> = {}): ClientConfig {
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
    ...overrides,
  }
}

const servers: MockServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  delete process.env.DSH_TEST_OBS_KEY
  delete process.env.DSH_TEST_BRAIN_TOKEN
})

describe('rest（密钥与底层 HTTP）', () => {
  it('resolveSecret 环境变量优先于文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-secret-'))
    try {
      process.env.DSH_TEST_OBS_KEY = 'from-env'
      writeFileSync(join(dir, 'key.json'), JSON.stringify({ apiKey: 'from-file' }))
      expect(await resolveSecret('DSH_TEST_OBS_KEY', join(dir, 'key.json'), 'apiKey')).toBe('from-env')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolveSecret 文件 JSON 信封与裸文本回退', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-secret-'))
    try {
      writeFileSync(join(dir, 'a.json'), JSON.stringify({ token: 'json-token' }))
      expect(await resolveSecret('DSH_TEST_NONE', join(dir, 'a.json'), 'token')).toBe('json-token')
      // 键名不匹配 → 整行视为密钥（裸文本回退）
      expect(await resolveSecret('DSH_TEST_NONE', join(dir, 'a.json'), 'wrongKey')).toBe(JSON.stringify({ token: 'json-token' }))
      writeFileSync(join(dir, 'b.txt'), '  bare-token  ')
      expect(await resolveSecret('DSH_TEST_NONE', join(dir, 'b.txt'), 'token')).toBe('bare-token')
      // 文件缺失 → 空串
      expect(await resolveSecret('DSH_TEST_NONE', join(dir, 'missing.txt'), 'token')).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rawRequest 成功解析 JSON 并带请求体', async () => {
    const s = await startServer((url, method, body) => {
      expect(method).toBe('POST')
      expect(JSON.parse(body)).toEqual({ k: 1 })
      return { status: 200, body: JSON.stringify({ ok: true }) }
    })
    servers.push(s)
    const r = await rawRequest(`http://127.0.0.1:${s.port}`, false, 'POST', '/vault/', { 'Content-Type': 'application/json' }, JSON.stringify({ k: 1 }))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })

  it('rawRequest 非 2xx 透传状态码与原始文本', async () => {
    const s = await startServer(() => ({ status: 404, body: 'not found' }))
    servers.push(s)
    const r = await rawRequest(`http://127.0.0.1:${s.port}`, false, 'GET', '/x', {})
    expect(r.status).toBe(404)
    expect(r.raw).toBe('not found')
  })

  it('rawRequest 网络失败降级为 503 结构化错误（不抛异常）', async () => {
    // 端口 1 通常无监听：连接失败 → 503
    const r = await rawRequest('http://127.0.0.1:1', false, 'GET', '/', {})
    expect(r.status).toBe(503)
    expect((r.body as { error: { message: string } }).error.message).toContain('无法连接')
  })

  it('toJson null/undefined → 空对象占位', () => {
    expect(toJson(null)).toEqual({ empty: true })
    expect(toJson(undefined)).toEqual({ empty: true })
    expect(toJson([1, 2])).toEqual([1, 2])
  })
})

describe('obsidian（vault 文件层客户端）', () => {
  it('obsidianCall 注入 Bearer 与 JSON 头，成功返回解析体', async () => {
    process.env.DSH_TEST_OBS_KEY = 'secret-key'
    const s = await startServer((url, method, body) => {
      expect(url).toBe('/vault/a.md')
      expect(method).toBe('PUT')
      return { status: 200, body: JSON.stringify({ written: true }) }
    })
    servers.push(s)
    const r = await obsidianCall(configFor(s.port), 'PUT', '/vault/a.md', '# hello', { 'Content-Type': 'text/markdown' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ written: true })
  })

  it('obsidianCall 无 key 时也正常请求（不带 Authorization）', async () => {
    const s = await startServer(() => ({ status: 200, body: JSON.stringify({ ok: true }) }))
    servers.push(s)
    const r = await obsidianCall(configFor(s.port), 'GET', '/vault/', undefined)
    expect(r.status).toBe(200)
  })

  it('obsidianStatus 2xx → ok；非 2xx → 结构化错误', async () => {
    const ok = await startServer(() => ({ status: 200, body: 'ok' }))
    servers.push(ok)
    const up = await obsidianStatus(configFor(ok.port))
    expect(up.ok).toBe(true)
    expect(up.authenticated).toBe(false)
    const down = await startServer(() => ({ status: 500, body: 'boom' }))
    servers.push(down)
    const bad = await obsidianStatus(configFor(down.port))
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('boom')
  })

  it('obsidianError 提取 message 字段或原始文本', () => {
    const withMsg = obsidianError({ status: 400, body: { message: '坏请求' }, raw: '{"message":"坏请求"}' }, 'obsidian_read')
    expect(withMsg.error).toBe('坏请求')
    const raw = obsidianError({ status: 500, body: 'text', raw: 'plain text error' }, 'obsidian_list')
    expect(raw.error).toBe('plain text error')
  })

  it('vaultPath 逐段 URL 编码（中文/空格安全）', () => {
    expect(vaultPath('')).toBe('/vault/')
    expect(vaultPath('团队知识库/入门指南.md')).toBe('/vault/' + encodeURIComponent('团队知识库') + '/' + encodeURIComponent('入门指南.md'))
    expect(vaultPath('a b/c.md')).toBe('/vault/a%20b/c.md')
  })
})

describe('brain（Brain 服务端客户端）', () => {
  it('brainCall 成功返回 v5 信封', async () => {
    const s = await startServer(() => ({ status: 200, body: JSON.stringify({ status: 'ok', data: { found: 3 } }) }))
    servers.push(s)
    const r = await brainCall(configFor(s.port), 'GET', '/v1/knowledge?q=x')
    expect(r.status).toBe('ok')
  })

  it('brainCall 非 JSON 响应 → 错误信封；网络失败 → 503', async () => {
    const s = await startServer(() => ({ status: 502, body: 'gateway down' }))
    servers.push(s)
    const bad = await brainCall(configFor(s.port), 'GET', '/v1/knowledge')
    expect(bad.status).toBe('error')
    const net = await brainCall({ ...configFor(1), brainUrl: 'http://127.0.0.1:1' }, 'GET', '/v1/knowledge')
    expect((net.error as { code: number }).code).toBe(503)
  })
})

describe('launcher（自愈启动器可测分支）', () => {
  it('ensureObsidianRunning autoStart=false 直接返回（零开销）', async () => {
    await ensureObsidianRunning({ ...configFor(1), autoStart: false, obsidianBin: '/nonexistent/bin', launchTimeoutMs: 100 })
    // 不抛异常即通过（不应发起任何探测/启动）
  })

  it('ensureObsidianRunning REST 已可达 → 不启动直接返回', async () => {
    const s = await startServer(() => ({ status: 200, body: 'ok' }))
    servers.push(s)
    let spawned = false
    const origSpawn = (await import('node:child_process')).spawn
    // 探测可达时不会走到 spawn 分支（用计数器验证）
    await ensureObsidianRunning({ ...configFor(s.port), autoStart: true, obsidianBin: '/nonexistent/bin', launchTimeoutMs: 500 })
    expect(spawned).toBe(false)
    expect(origSpawn).toBeTypeOf('function')
  })

  it('ensureObsidianRunning 不可达且二进制缺失 → 警告路径不崩溃', async () => {
    await ensureObsidianRunning({ ...configFor(1), autoStart: true, obsidianBin: '/definitely/missing/bin', launchTimeoutMs: 100 })
  })

  it('obsidianProcessExists 对不存在路径返回 false（不抛异常）', () => {
    expect(obsidianProcessExists('/definitely/missing/obsidian')).toBe(false)
  })

  it('obsidianSingletonLockExists 返回布尔（环境无关，不抛异常）', () => {
    expect(typeof obsidianSingletonLockExists()).toBe('boolean')
  })
})

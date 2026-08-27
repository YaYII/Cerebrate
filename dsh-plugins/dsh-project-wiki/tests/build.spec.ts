/**
 * business/build.ts 单元测试——子代理编排层。
 *
 * build.ts 的业务是「把知识库构建/增量刷新任务提交给 DSH 子代理」：
 * submitWikiBuild（创建代理 + 驱动执行 + 提取结果）、runAiLeadBuild（任务文本生成
 * + 委托）、buildTaskText（AI 主导工作流任务文本）。全部通过注入假 ctx/假 handle
 * 实测，不依赖真实 Cordis 注册表。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { buildTaskText, submitWikiBuild, runAiLeadBuild } from '../src/business/build'

/** 构造一个只提供 agents 注册表的假 ctx（get 只响应 agents）。 */
function fakeCtx(agents: unknown): Context {
  return { get: (name: string) => (name === 'agents' ? agents : undefined) } as unknown as Context
}

/** 构造假 AgentHandle：捕获 followup 消息，events 可注入，dispose 可观测。 */
function fakeHandle(events: unknown[], onFollowup?: (message: unknown) => void) {
  let disposed = false
  const handle = {
    agent: {
      session: { events },
      followup: (message: unknown) => onFollowup?.(message),
      whenIdle: async () => {},
    },
    dispose: async () => { disposed = true },
  }
  return { handle, disposed: () => disposed }
}

describe('buildTaskText（AI 主导构建任务文本）', () => {
  it('包含认识项目、Mermaid 安全写法、分页落盘三步工作流', () => {
    const task = buildTaskText('demo', '/vault', '项目知识库', true)
    expect(task).toContain('# 任务：为项目「demo」构建 AI 知识库')
    expect(task).toContain('wiki_tree project=<路径>')
    expect(task).toContain('Mermaid 安全写法')
    expect(task).toContain('每完成一页立即')
    expect(task).toContain('/vault/项目知识库/demo/')
    expect(task).toContain('commit=' + true)
  })

  it('commit=false 时任务文本携带 false（变异点：commit 插值）', () => {
    const task = buildTaskText('p2', '/v', 'kb', false)
    expect(task).toContain('commit=false')
    expect(task).not.toContain('commit=true')
  })
})

describe('submitWikiBuild（子代理提交与驱动）', () => {
  it('agents 注册表缺失时返回中文错误（不崩溃）', async () => {
    const r = await submitWikiBuild({
      ctx: fakeCtx(undefined),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
    })
    expect(r.report).toBe('')
    expect(r.error).toContain('代理注册表不可用')
  })

  it('agents.create 抛错时返回创建失败错误', async () => {
    const agents = { create: async () => { throw new Error('registry boom') } }
    const r = await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
    })
    expect(r.error).toBe('创建构建子代理失败')
  })

  it('成功路径：驱动子代理执行并把最后一条助手文本作为报告', async () => {
    const events = [
      { type: 'user/message', data: { content: [{ type: 'text', text: '构建吧' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '完成：3 页知识库' }] } },
      { type: 'turn/end', data: { reason: { kind: 'ok' } } },
    ]
    const { handle, disposed } = fakeHandle(events)
    const agents = { create: async () => handle }
    const r = await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务文本',
    })
    expect(r.report).toBe('完成：3 页知识库')
    expect(r.error).toBeUndefined()
    expect(disposed()).toBe(true) // 无论成败都释放子代理句柄
  })

  it('最终轮次以错误结束时报告错误（不误报空成功）', async () => {
    const events = [
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '写了一半' }] } },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'insufficient balance', code: 'E402' } } } },
    ]
    const { handle } = fakeHandle(events)
    const agents = { create: async () => handle }
    const r = await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
    })
    expect(r.report).toBe('写了一半')
    expect(r.error).toContain('LLM 调用失败：insufficient balance')
    expect(r.error).toContain('E402')
  })

  it('空助手文本不覆盖已有报告（变异点：report 首条非空才赋值）', async () => {
    const events = [
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '  ' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '最终总结' }] } },
    ]
    const { handle } = fakeHandle(events)
    const agents = { create: async () => handle }
    const r = await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
    })
    expect(r.report).toBe('最终总结')
  })

  it('driveBuild 异常时兜底返回错误并释放句柄', async () => {
    // whenIdle 抛错 → driveBuild catch 分支
    const handle = {
      agent: {
        session: { events: [] },
        followup: () => {},
        whenIdle: async () => { throw new Error('idle 中断') },
      },
      dispose: async () => {},
    }
    const agents = { create: async () => handle }
    const r = await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
    })
    expect(r.error).toContain('idle 中断')
  })

  it('onProgress 回调逐阶段触发', async () => {
    const { handle } = fakeHandle([])
    const agents = { create: async () => handle }
    const progress: string[] = []
    await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
      onProgress: (msg: string) => progress.push(msg),
    })
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0]).toContain('启动 AI 构建子代理')
  })

  it('inheritAgent 提供 requestContext 时继承实际生效模型路由（live 优先于静态 options）', async () => {
    const capture: { opts?: Record<string, unknown> } = {}
    const agents = { create: async (opts: Record<string, unknown>) => { capture.opts = opts; return fakeHandle([]).handle } }
    await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
      signal: new AbortController().signal,
      inheritAgent: {
        session: { requestContext: () => ({ provider: 'live-p', model: 'live-m' }) },
        options: { provider: 'static-p', model: 'static-m' },
      },
    })
    expect(capture.opts?.agentOptions).toEqual({ provider: 'live-p', model: 'live-m' })
    expect(capture.opts?.signal).toBeDefined() // AbortSignal 透传子代理
  })

  it('requestContext 无路由时回退到静态 options', async () => {
    const capture: { opts?: Record<string, unknown> } = {}
    const agents = { create: async (opts: Record<string, unknown>) => { capture.opts = opts; return fakeHandle([]).handle } }
    await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
      inheritAgent: { session: { requestContext: () => undefined }, options: { provider: 'static-p', model: 'static-m' } },
    })
    expect(capture.opts?.agentOptions).toEqual({ provider: 'static-p', model: 'static-m' })
  })

  it('两者皆无时不传 agentOptions（不固定任何模型）', async () => {
    const capture: { opts?: Record<string, unknown> } = {}
    const agents = { create: async (opts: Record<string, unknown>) => { capture.opts = opts; return fakeHandle([]).handle } }
    await submitWikiBuild({
      ctx: fakeCtx(agents),
      projectPath: '/tmp/p',
      vaultDir: '/tmp/v',
      kbRoot: 'kb',
      task: '任务',
      inheritAgent: { session: { requestContext: () => undefined }, options: {} },
    })
    expect(capture.opts?.agentOptions).toBeUndefined()
  })
})

describe('runAiLeadBuild（任务文本生成与委托）', () => {
  it('默认生成构建任务；taskOverride 优先（evolve 传入增量任务）', async () => {
    const seen: unknown[] = []
    const { handle } = fakeHandle([
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'ok' }] } },
    ], m => seen.push(m))
    const agents = { create: async () => handle }
    // taskOverride 优先：项目名取自路径尾部
    await runAiLeadBuild({
      ctx: fakeCtx(agents),
      projectPath: '/work/demo-proj',
      vaultDir: '/v',
      kbRoot: 'kb',
      commit: false,
      taskOverride: '增量刷新：2 个文件变化',
    })
    expect(seen).toHaveLength(1)
    const message = JSON.stringify(seen[0])
    expect(message).toContain('增量刷新：2 个文件变化')
    expect(message).not.toContain('构建 AI 知识库')
  })

  it('无 taskOverride 时生成完整构建任务（含项目名与 commit）', async () => {
    const seen: unknown[] = []
    const { handle } = fakeHandle([], m => seen.push(m))
    const agents = { create: async () => handle }
    await runAiLeadBuild({
      ctx: fakeCtx(agents),
      projectPath: '/work/demo-proj',
      vaultDir: '/v',
      kbRoot: 'kb',
      commit: true,
    })
    const message = JSON.stringify(seen[0])
    expect(message).toContain('构建 AI 知识库')
    expect(message).toContain('demo-proj')
    expect(message).toContain('commit=true')
  })
})

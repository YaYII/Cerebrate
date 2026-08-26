/**
 * dsh-project-wiki —— DeepSeek Harness 的 AI 主导项目知识库插件。
 *
 * 万物为 AI 服务。本插件不解析代码、不生成内容，只给 AI 提供六类生态工具：
 *
 *   wiki_tree   —— 浏览项目真实目录树（识别模块边界）
 *   wiki_read   —— 有界读取任意文件内容
 *   wiki_write  —— 把 AI 撰写的页面落盘到 Obsidian vault（含 Mermaid 清洗与证据校验）
 *   wiki_build  —— 把完整知识库构建任务提交给 DSH 子代理（AI 自行完成全流程）
 *   wiki_status —— 检查代码与知识库快照是否同步（git head + 文件 digest 判变）
 *   wiki_evolve —— 代码变化后让 AI 只刷新受影响的页面（增量，不重建）
 *
 * 架构采用「契约注册表 + 实现注册表 + 装配工厂」：契约（contracts.ts）是
 * 单一真源，实现（本文件）只提供行为，buildTool 工厂把二者组装成工具注册。
 * 依赖方向：装配层 → 能力层（浏览、写入、构建、进化、扫描、校验各模块）。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TOOL_CONTRACTS, contractOf } from './features/contracts'
import type { ToolContract } from './features/contracts'
import { buildImpls } from './business/impls'

/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
export const name = 'dsh-project-wiki'
export const inject = ['tools', 'llm', 'agentDefaultModel', 'agents']

/** 插件配置。 */
export interface Config {
  /** Obsidian vault 根目录（自动生成的知识库页面存放于此）。 */
  vaultDir: string
  /** vault 内知识库根目录名。 */
  kbRoot: string
  /** 是否在首个 step 注入 wiki 工作流引导。 */
  injectGuidance: boolean
  /** wiki_write 是否默认 git 提交。 */
  autoCommit: boolean
  /** 自动进化：每 N 毫秒轮询项目根目录，代码变化时刷新知识库（0 = 关闭）。 */
  evolveIntervalMs: number
  /** 自动进化监控的项目目录（绝对路径）。 */
  evolveProjects: string[]
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  vaultDir: z.string().default('~/Documents/team-kb'),
  kbRoot: z.string().default('项目知识库'),
  injectGuidance: z.boolean().default(true),
  autoCommit: z.boolean().default(true),
  evolveIntervalMs: z.number().default(0),
  evolveProjects: z.array(z.string()).default([]),
})

/**
 * 注入到首个 agent step 的引导：如何用这些工具构建知识库——AI 主导，
 * 而非模板驱动。
 */
const WIKI_GUIDANCE = [
  '【项目知识库】本会话具备 dsh-project-wiki 工具（wiki_tree/read/write/build/status/evolve），',
  '构建知识库由 AI 主导：先用 wiki_tree 看真实目录树，识别真实模块边界',
  '（前后端分离的项目 backend/ frontend/ docker/ database/ 各是独立知识区域），',
  '再用 wiki_read 通读关键文件（README/AGENTS/依赖清单/入口/配置），',
  '最后按「模块 → 架构 → 业务 → 技术」规划页面并逐页用 wiki_write 落盘。',
  'wiki_build 可一次性提交完整构建任务给 DSH 子代理（AI 自行完成全部流程）。',
  '代码变更后：wiki_status 查同步状态，wiki_evolve 让 AI 只刷新受影响的页面（增量，不重建）；',
  '配置 evolveIntervalMs+evolveProjects 可定时自动检测代码变化并触发更新。',
  '知识库写入 <vaultDir>/<kbRoot>/<项目>/，默认自动 git 提交；产物供后续 AI 理解系统。',
  '不要用模板套结构：页面组织与内容深度由 AI 根据项目复杂度决定。',
].join('\n')

/** 引导是否已出现在会话可见面。 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.events[seq]
    return event?.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === PLUGIN_TAG
  })
}

/** 本包注入消息的来源插件标签。 */
const PLUGIN_TAG = 'dsh-project-wiki'

/** 把工具返回值以美化 JSON 文本呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** wiki 工具的通用 UI 卡片。 */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/** 把项目参数解析为绝对路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/**
 * 工具装配工厂：把一份契约 + 一个实现组装成 defineTool 注册。
 * 参数模式由契约入参推导——注册与文档共享单一真源，永不漂移。
 */
function buildTool(contract: ToolContract, impl: (args: Record<string, unknown>, exec?: ToolRunContext) => Promise<Record<string, unknown>>) {
  const parameters: Record<string, { type: 'string' | 'boolean'; required?: true; description: string }> = {}
  for (const input of contract.inputs) {
    parameters[input.name] = {
      type: input.type === 'boolean' ? 'boolean' : 'string',
      ...(input.required === true ? { required: true as true } : {}),
      description: input.description,
    }
  }
  return defineTool({
    name: contract.id,
    description: contract.summary + ' ' + contract.description,
    parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args: Record<string, unknown> & Record<string, JsonValue | undefined>, exec: ToolRunContext) {
      return impl(args, exec) as Promise<Record<string, JsonValue>>
    },
    presentCall: args => presentCall(contract.name, args),
  })
}

/** 注册 wiki 工具集；开启时注入工作流引导与自动进化定时器。 */
export function apply(ctx: Context, config: Config): void {
  const impls = buildImpls(ctx, config)
  for (const impl of impls) {
    const contract = contractOf(impl.contractId)
    if (!contract) continue
    ctx.tools.register(buildTool(contract, impl.execute))
  }

  // 自动进化：定时检测代码变化 → 触发 AI 增量刷新
  if (config.evolveIntervalMs > 0 && config.evolveProjects.length > 0) {
    const scanImpl = impls.find(i => i.contractId === 'wiki_status')
    const evolveImpl = impls.find(i => i.contractId === 'wiki_evolve')
    if (evolveImpl) {
      const timer = setInterval(async () => {
        for (const project of config.evolveProjects) {
          try {
            // 只读判变（wiki_status 逻辑）：有变化才触发 evolve
            const st = await scanImpl?.execute({ project }) ?? { status: 'error' }
            const data = (st as { data?: { synced?: boolean } }).data
            if (data?.synced === false) {
              ctx.logger.info('[project-wiki] 检测到代码变化，触发增量刷新: ' + project)
              const r = await evolveImpl.execute({ project })
              if ((r as { status?: string }).status !== 'ok') {
                ctx.logger.warn('[project-wiki] 自动进化失败: ' + JSON.stringify(r).slice(0, 300))
              }
            }
          } catch (err) {
            ctx.logger.warn('[project-wiki] 自动进化异常: ' + String((err as Error)?.message ?? err))
          }
        }
      }, config.evolveIntervalMs)
      ctx.effect(() => () => clearInterval(timer))
    }
  }

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
        content: [{ type: 'text', text: WIKI_GUIDANCE }],
        source: { kind: 'plugin', plugin: PLUGIN_TAG, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

/** 供程序化使用的再导出。 */
export { projectTree, readFileBounded } from './features/io'
export { writePage, vaultCommit, listPages, wikiDirFor, stampFrontmatter } from './features/writer'
export { runAiLeadBuild, submitWikiBuild, buildTaskText } from './business/build'
export { TOOL_CONTRACTS } from './features/contracts'

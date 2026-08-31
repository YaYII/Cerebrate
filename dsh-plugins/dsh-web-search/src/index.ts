/**
 * DeepSeek Harness 的 AI 自主搜索阅读插件。
 *
 * 注册原生 `web_search` 与 `web_read` 工具——AI 可以直接搜索网页、
 * 解析任意 URL 为 LLM 友好的 Markdown 并阅读。纯插件路径，全程无 MCP。
 *
 * 架构分层：本文件是装配层（工具注册 + 引导注入）；能力在 features/
 * （rest 底层 HTTP、searxng 搜索客户端、reader 网页解析客户端）。
 *
 * @module @deepseek-ai/dsh-web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toJson, type ClientConfig } from './features/rest'
import { searchWeb } from './features/searxng'
import { parsePage } from './features/reader'

/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
export const name = 'dsh-web-search'
export const inject = ['tools']

/** 插件配置（实现 features/rest 的 ClientConfig 形状 + 引导开关）。 */
export interface Config extends ClientConfig {
  /** 是否在首个 step 注入搜索优先引导。 */
  injectGuidance: boolean
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  searxngUrl: z.string().default('http://127.0.0.1:8080'),
  crawl4aiUrl: z.string().default('http://127.0.0.1:11235'),
  crawl4aiToken: z.string().default('dsh-local-crawl-token-2026'),
  jinaReaderUrl: z.string().default('https://r.jina.ai'),
  timeoutMs: z.number().default(30000),
  maxResults: z.number().default(8),
  injectGuidance: z.boolean().default(true),
})

/** 折叠进首个 agent step 的搜索优先引导。 */
const GUIDANCE = [
  '【自主搜索阅读】本会话具备 dsh-web-search 插件能力：',
  '1. web_search（搜索）：向自托管 SearXNG 元搜索提问，返回带 URL 的结果列表。',
  '2. web_read（阅读）：把任意网页 URL 解析为 LLM 友好的 Markdown，供直接阅读。',
  '',
  '用法：需要最新信息 / 查资料 / 调研时，先 web_search 找 URL，再 web_read 精读目标页。',
  '已有结论需验证时，优先用 web_search 检索 + web_read 读原文确认，不凭记忆臆断。',
].join('\n')

/** 本包注入消息的来源插件标签。 */
const PLUGIN_TAG = 'dsh-web-search'

/** 引导消息是否已存在于会话可见面。 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.events[seq]
    return event?.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === PLUGIN_TAG
  })
}

/** 把工具返回值以美化 JSON 文本呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 工具调用展示卡片。 */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/**
 * 注册 `web_search` 与 `web_read` 工具，并按配置注入搜索优先引导。
 * @param ctx - 携带工具注册表的注册上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const tools = {
    search: defineTool({
      name: 'web_search',
      description: '搜索网页：向自托管 SearXNG 元搜索提问（聚合 Google/Bing/DDG 等），返回带标题/URL/摘要的结果列表。适合查最新资料、调研、找网页。',
      parameters: {
        query: { type: 'string', description: '搜索词', required: true },
        language: { type: 'string', description: '结果语言，如 zh-CN / en / ja', default: 'zh-CN' },
        maxResults: { type: 'number', description: '返回条数上限', default: 8 },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const query = String(args.query ?? '').trim()
        if (query.length === 0) return { ok: false, error: '搜索词不能为空' }
        const lang = String(args.language ?? 'zh-CN')
        const max = Math.min(Number(args.maxResults ?? config.maxResults) || config.maxResults, 20)
        const outcome = await searchWeb(config, query, lang, max)
        if (!outcome.ok) return { ok: false, query, ...(outcome.error !== undefined ? { error: outcome.error } : {}) }
        return { ok: true, query, count: outcome.hits.length, results: toJson(outcome.hits) }
      },
      presentCall: args => presentCall('Search the web', args),
    }),
    read: defineTool({
      name: 'web_read',
      description: '阅读网页：把任意 URL 解析为 LLM 友好的 Markdown（crawl4ai 优先，Jina Reader 兜底）。适合精读搜索结果、文档、新闻原文。',
      parameters: {
        url: { type: 'string', description: '要解析的目标 URL', required: true },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const url = String(args.url ?? '').trim()
        if (url.length === 0) return { ok: false, error: 'URL 不能为空' }
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL 需以 http(s):// 开头' }
        const outcome = await parsePage(config, url)
        if (!outcome.ok) return { ok: false, url, backend: outcome.backend, ...(outcome.error !== undefined ? { error: outcome.error } : {}) }
        return { ok: true, url, backend: outcome.backend, content: outcome.content.slice(0, 20000) }
      },
      presentCall: args => presentCall('Read a web page', args),
    }),
  }

  // 注册工具
  for (const tool of Object.values(tools)) {
    ctx.tools.register(tool)
  }

  // 引导注入：仅当开启且尚未注入时，向会话表面追加一条插件来源说明。
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

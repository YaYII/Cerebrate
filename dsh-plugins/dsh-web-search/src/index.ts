/**
 * DeepSeek Harness 的 AI 自主搜索阅读插件（SearXNG 自托管后端）。
 *
 * 两个能力：
 *   1. 注册 `searxng-local` 搜索 provider 进 `ctx.web` 接缝——模型侧的
 *      `web_search` 工具由 `@deepseek-ai/dsh-tool-web` 提供，本插件
 *      只提供「把查询变成结果」的自托管后端（无 API key、无外部依赖）。
 *   2. 注册 `web_read` 工具——把任意 URL 解析为 LLM 友好的 Markdown
 *      （crawl4ai 优先，Jina Reader 兜底），补上「阅读」能力。
 *
 * 架构分层：本文件是装配层（provider 注册 + 工具注册 + 引导注入）；能力在
 * features/（searxng provider、reader 网页解析客户端）。
 *
 * @module @deepseek-ai/dsh-web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toJson } from './features/rest'
import { parsePage } from './features/reader'
import {
  SearXNGSearchProvider,
  SEARXNG_PROVIDER_ID,
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_DEFAULT_LANGUAGE,
  SEARXNG_DEFAULT_TIMEOUT_MS,
} from './features/searxng'

/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
export const name = 'dsh-web-search'
export const inject = ['tools', 'web']

/** 插件配置。 */
export interface Config {
  /** SearXNG 服务地址。 */
  searxngUrl: string
  /** 搜索语言。 */
  searchLanguage: string
  /** SearXNG 请求超时（毫秒）。 */
  searxngTimeoutMs: number
  /** 搜索默认返回条数。 */
  searchMaxResults: number
  /** crawl4ai 服务地址（留空则仅用 Jina Reader）。 */
  crawl4aiUrl: string
  /** crawl4ai API token（服务端未开启鉴权时留空）。 */
  crawl4aiToken: string
  /** Jina Reader 服务地址（自托管或官方 r.jina.ai）。 */
  jinaReaderUrl: string
  /** 网页解析请求超时（毫秒）。 */
  readTimeoutMs: number
  /** 是否在首个 step 注入搜索优先引导。 */
  injectGuidance: boolean
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  searxngUrl: z.string().default(SEARXNG_DEFAULT_BASE_URL),
  searchLanguage: z.string().default(SEARXNG_DEFAULT_LANGUAGE),
  searxngTimeoutMs: z.number().default(SEARXNG_DEFAULT_TIMEOUT_MS),
  searchMaxResults: z.number().default(8),
  crawl4aiUrl: z.string().default('http://127.0.0.1:11235'),
  crawl4aiToken: z.string().default('dsh-local-crawl-token-2026'),
  jinaReaderUrl: z.string().default('https://r.jina.ai'),
  readTimeoutMs: z.number().default(30000),
  injectGuidance: z.boolean().default(true),
})

/** 折叠进首个 agent step 的搜索优先引导。 */
const GUIDANCE = [
  '【自主搜索阅读】本会话具备 dsh-web-search 插件能力：',
  '1. web_search（搜索）：自托管 SearXNG 元搜索（无 API key），返回带 URL 的结果列表。',
  '2. web_read（阅读）：把任意网页 URL 解析为 LLM 友好的 Markdown，供直接阅读。',
  '',
  '用法：需要最新信息 / 查资料 / 调研时，先 web_search 找 URL，再 web_read 精读目标页。',
  '已有结论需验证时，优先用 web_search 检索 + web_read 读原文确认，不凭记忆臆断。',
].join('\n')

/** 本包注入消息的来源插件标签。 */
const PRODUCER_KIND = 'dsh-web-search'

/** 本包注入消息的生产者 kind（producer-owned source）。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-web-search': { kind: 'dsh-web-search'; form?: 'instructions' }
  }
}

/** 旧版 V3 会话消息迁移后的 kind；识别它以免升级后的会话重复注入。 */
const MIGRATED_PRODUCER_KIND = `plugin:${PRODUCER_KIND}`

/** 引导消息是否已存在于会话可见面。 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') return false
    const kind: string = event.data.source.kind
    return kind === PRODUCER_KIND || kind === MIGRATED_PRODUCER_KIND
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
 * 注册 `searxng-local` 搜索 provider 与 `web_read` 工具，并按配置注入
 * 搜索优先引导。
 * @param ctx - 携带工具注册表与 web 接缝的注册上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  // 1) 注册 SearXNG 搜索 provider（模型侧 web_search 工具由 tool-web 提供）
  ctx.web.registerSearchProvider(new SearXNGSearchProvider({
    baseURL: config.searxngUrl,
    language: config.searchLanguage,
    timeoutMs: config.searxngTimeoutMs,
    ...config.searchMaxResults > 0 ? { numResults: config.searchMaxResults } : {},
  }))

  // 2) 注册 web_read 工具（网页解析阅读）
  const tools = {
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
        const outcome = await parsePage({
          searxngUrl: config.searxngUrl,
          crawl4aiUrl: config.crawl4aiUrl,
          crawl4aiToken: config.crawl4aiToken,
          jinaReaderUrl: config.jinaReaderUrl,
          timeoutMs: config.readTimeoutMs,
          maxResults: config.searchMaxResults,
        }, url)
        if (!outcome.ok) return { ok: false, url, backend: outcome.backend, ...(outcome.error !== undefined ? { error: outcome.error } : {}) }
        return { ok: true, url, backend: outcome.backend, content: outcome.content.slice(0, 20000) }
      },
      presentCall: args => presentCall('Read a web page', args),
    }),
  }
  for (const tool of Object.values(tools)) ctx.tools.register(tool)

  // 3) 引导注入：仅当开启且尚未注入时，向会话表面追加一条插件来源说明。
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
        source: { kind: PRODUCER_KIND, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

export { SEARXNG_PROVIDER_ID }

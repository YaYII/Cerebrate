/**
 * DeepSeek Harness 的 Obsidian 团队知识库客户端。
 *
 * 通过 Local REST API 社区插件（默认 127.0.0.1:27124 安全 HTTPS、自签名
 * 证书）与本地 Obsidian vault 通信，并注册原生 `obsidian_*` 与
 * `knowledge_*` 工具——团队知识库直接参与 agent 循环，纯插件路径，
 * 全程无 MCP。
 *
 * 两层知识，一个插件：
 *   1. obsidian_* 工具  — vault 文件层（对普通 Markdown 文件的读写/搜索/
 *                         补丁/列表/命令/打开）。
 *   2. knowledge_* 工具 — Brain 服务端权威团队知识库（向量语义检索 +
 *                         分级写入：普通知识任何登录 agent 可写，
 *                         policy/权威文档仅管理员可写）。
 *
 * 引导注入把插件来源的说明消息折叠进首个 agent step，讲清记忆与知识库的
 * 区别及各自的具体工具。
 *
 * 架构分层：本文件是装配层（工具注册 + 引导注入 + 自愈触发）；能力在
 * features/（rest 底层 HTTP、obsidian 客户端、brain 客户端、launcher 自愈）。
 *
 * @module @deepseek-ai/dsh-obsidian
 */

import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { obsidianCall, obsidianError, obsidianStatus, vaultPath, toJson } from './features/obsidian'
import { brainCall } from './features/brain'
import { ensureObsidianRunning } from './features/launcher'
import type { ClientConfig } from './features/rest'

/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
export const name = 'dsh-obsidian'
export const inject = ['tools']

/** 插件配置（实现 features/rest 的 ClientConfig 形状 + 自愈参数）。 */
export interface Config extends ClientConfig {
  /** 是否在首个 step 注入知识优先引导。 */
  injectGuidance: boolean
  /** REST API 不可达时自动拉起本地 Obsidian（自愈）。 */
  autoStart: boolean
  /** 自动启动使用的 Obsidian 可执行文件绝对路径。 */
  obsidianBin: string
  /** 等待自动启动的 Obsidian 服务 API 的最长时间，ms。 */
  launchTimeoutMs: number
}

/** Schemastery 配置模式。 */
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

/** 折叠进首个 agent step 的知识优先引导：讲清记忆与知识库的区别及工具用法。 */
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

/** 本包注入消息的来源插件标签。 */
const PLUGIN_TAG = 'dsh-obsidian'

/** 引导消息是否已存在于会话可见面。 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.eventAt(seq)
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
 * 注册 `obsidian_*` 与 `knowledge_*` 工具集，并按配置注入知识优先引导。
 * 自愈启动为 fire-and-forget，工具注册从不被慢启动阻塞。
 * @param ctx - 携带工具注册表的注册上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  // 自愈依赖：REST API 不可达时拉起本地实例。fire-and-forget，
  // 失败降级为警告。
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
        // topics 契约是逗号分隔字符串（schema 已约束，无数组形态）
        const topics = String(args.topics ?? '').split(',').map(s => s.trim()).filter(Boolean)
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

/**
 * Cerebrate (虫群) team-memory client for DeepSeek Harness.
 *
 * Talks directly to a Cerebrate Brain Server over its REST API and registers
 * native `cerebrate_*` tools, so swarm memory participates in the agent loop
 * without an MCP translation hop. Memory-first guidance folds a
 * producer-owned instructions message into the first agent step telling the
 * model to consult team memory before acting and to contribute back after
 * solving a problem — team memory is shared across every member, not per-agent.
 *
 * @module @deepseek-ai/dsh-memory-cerebrate
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'memory-cerebrate'
export const inject = ['tools']

/** Cerebrate team-memory client configuration. */
export interface Config {
  /** Brain Server base URL, without a trailing slash. */
  baseUrl: string
  /** Environment-variable name holding the Bearer token. */
  tokenEnv: string
  /** Local token file path (`~` expands to the home directory); a JSON `{ "token": "..." }` or plain text token. */
  tokenFile: string
  /** Default user id sent with personal-memory operations. */
  user: string
  /** Default agent id recorded on search and propose operations. */
  agentId: string
  /** Whether the memory-first guidance message is injected into the first agent step. */
  injectMemoryGuidance: boolean
}

/** Schemastery configuration for the memory client. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8765'),
  tokenEnv: z.string().default('CEREBRATE_SERVER_TOKEN'),
  tokenFile: z.string().default('~/.cerebrate/token'),
  user: z.string().default('yangying'),
  agentId: z.string().default('dsh'),
  injectMemoryGuidance: z.boolean().default(true),
})

/** One v5-protocol envelope returned by the Brain Server. */
export interface CerebrateEnvelope {
  status: string
  data?: unknown
  error?: { code?: number | string; message?: string; hint?: string }
  meta?: unknown
}

/** The envelope narrowed to the lossless-JSON value the tool executor emits. */
type EnvelopeValue = Record<string, JsonValue>

/**
 * Resolve the Bearer token: the configured environment variable wins, then the
 * token file (JSON `{ "token": ... }` or a bare token line).
 * @param config - client configuration.
 * @returns the token, or an empty string when neither source carries one.
 */
async function resolveToken(config: Config): Promise<string> {
  const fromEnv = process.env[config.tokenEnv]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const file = config.tokenFile.replace(/^~/, os.homedir())
  try {
    const raw = (await readFile(file, 'utf8')).trim()
    if (raw.length === 0) return ''
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && 'token' in parsed) {
        const token = parsed.token
        return typeof token === 'string' ? token : ''
      }
    } catch {
      // Not JSON: treat the whole line as the token.
    }
    return raw
  } catch {
    return ''
  }
}

/**
 * Call one Brain Server endpoint and return its v5 envelope. Network failures
 * and non-JSON bodies degrade to a structured error envelope so the model sees
 * a reason instead of a thrown exception.
 * @param config - client configuration.
 * @param method - HTTP method.
 * @param apiPath - endpoint path, e.g. `/v1/search`.
 * @param body - optional JSON request body.
 * @returns the parsed envelope.
 */
async function cerebrateRequest(
  config: Config,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<EnvelopeValue> {
  const token = await resolveToken(config)
  const url = `${config.baseUrl.replace(/\/$/, '')}${apiPath}`
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
      return JSON.parse(text) as EnvelopeValue
    } catch {
      return { status: 'error', error: { code: response.status, message: text } }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 'error', error: { code: 503, message: `无法连接脑虫服务 ${url}: ${reason}` } }
  }
}

/** Render one envelope to the model as pretty-printed JSON text. */
function renderEnvelope(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** Common UI card for the memory tools. */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/**
 * Memory-first guidance folded into the first agent step. It states that the
 * Cerebrate swarm memory is a team-shared store, tells the model to consult it
 * before acting and to contribute lessons back, and names the concrete tools.
 */
const MEMORY_GUIDANCE = [
  '【团队记忆】本会话连接 Cerebrate 虫群记忆——团队共享、跨会话跨成员持久的企业记忆库，不是单兵记忆。',
  '行动前，先检索团队是否已解决过当前问题：用 cerebrate_search 查索引（必要时 cerebrate_detail 取详情、cerebrate_query 要决策建议），命中即复用，不必从零开始。',
  '任务开始时可用 cerebrate_sense 感知脑状态（记忆规模、告警）。',
  '解决问题后，用 cerebrate_propose 把经验、根因、方案沉淀进团队记忆，让后续成员受益；沉淀前先检索避免重复。',
  '个人偏好用 cerebrate_recall / cerebrate_remember；规模统计用 cerebrate_stats。',
].join('\n')

/** Producer kind this package's guidance injections declare. */
const PRODUCER_KIND = 'memory-cerebrate'

/**
 * Released V3 rows carrying this package's guidance migrate to this producer
 * kind (`plugin:` plus the original plugin name); recognizing it keeps an
 * upgraded session from receiving the guidance a second time.
 */
const MIGRATED_PRODUCER_KIND = `plugin:${PRODUCER_KIND}`

/** Producer-owned source of one memory-guidance injection. */
interface MemoryGuidanceSource {
  kind: 'memory-cerebrate'
  form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-cerebrate': MemoryGuidanceSource
  }
}

/**
 * Whether the guidance message already lives in the session's visible surface,
 * so a later turn never injects it a second time.
 * @param agent - the agent whose session surface to inspect.
 * @returns true when the guidance is already present.
 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') return false
    const kind: string = event.data.source.kind
    return kind === PRODUCER_KIND || kind === MIGRATED_PRODUCER_KIND
  })
}

/**
 * Register the `cerebrate_*` tool set and, when enabled, the memory-first
 * guidance injection on the first agent step.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - client configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = {
    sense: defineTool({
      name: 'cerebrate_sense',
      description: '【会话开始必须调用】感知虫群脑状态，返回健康状态、记忆总数、代理数、warnings。\n\n3-LAYER WORKFLOW（记忆检索，ALWAYS FOLLOW）:\n  1. cerebrate_search(query) → 紧凑索引（ID/标题/类型/评分/token成本，~50-100 tokens/条）\n  2. cerebrate_timeline(anchor=ID) → 时序上下文（前因后果）\n  3. cerebrate_detail(ids=[...]) → 只取筛选后的完整详情（~500-1000 tokens/条）\nNEVER 直接拉全文：先索引筛选，再按需取详情（省 50-75% token）。\n有问题先 cerebrate_search，再决定取哪些 detail。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      execute: () => cerebrateRequest(config, 'GET', '/v1/sense'),
      presentCall: args => presentCall('Sense swarm brain state', args),
    }),
    search: defineTool({
      name: 'cerebrate_search',
      description: '【遇到问题第一步调用】渐进式披露第 1 层：紧凑索引（不含全文）。返回 memory_id/标题/类型/评分/token成本，让 agent 先扫描再决定取哪些详情。\nmode: hybrid=FTS精确+向量语义(默认); fts=仅精确关键词(错误码/命令/函数名); vector=仅向量语义',
      parameters: {
        query: { type: 'string', required: true, description: '问题描述/关键词' },
        project_id: { type: 'string', description: '项目ID（可选），如 deepseek-harness' },
        scope: { type: 'string', enum: ['', 'general', 'project', 'all'], description: '记忆分类: general=只查通用记忆; project=项目记忆+通用记忆; all=跨项目全量' },
        category: { type: 'string', description: '分类过滤（可选）' },
        mode: { type: 'string', enum: ['hybrid', 'fts', 'vector'], description: '检索模式: hybrid=混合(默认); fts=仅全文精确; vector=仅向量语义' },
        limit: { type: 'integer', description: '返回条数' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      execute: args => cerebrateRequest(config, 'POST', '/v1/search', {
        query: args.query,
        agent_id: config.agentId,
        project_id: args.project_id ?? '',
        scope: args.scope ?? '',
        category: args.category ?? '',
        mode: args.mode ?? 'hybrid',
        limit: args.limit ?? 20,
      }),
      presentCall: args => presentCall('Search team memory', args),
    }),
    timeline: defineTool({
      name: 'cerebrate_timeline',
      description: '【了解前因后果时调用】渐进式披露第 2 层：围绕 anchor 记忆的时序上下文。基于事件日志，返回该记忆前后的相关事件（提出/查询/复用/投票）。',
      parameters: {
        anchor: { type: 'string', description: 'anchor 记忆 ID（不传则用 query 找 top1）' },
        query: { type: 'string', description: '查询词（anchor 缺省时自动找 top1）' },
        project_id: { type: 'string', description: '项目ID（可选）' },
        scope: { type: 'string', enum: ['', 'general', 'project', 'all'], description: '记忆分类' },
        depth_before: { type: 'integer', description: 'anchor 前取几条事件' },
        depth_after: { type: 'integer', description: 'anchor 后取几条事件' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      execute: args => cerebrateRequest(config, 'POST', '/v1/timeline', {
        anchor: args.anchor ?? '',
        query: args.query ?? '',
        project_id: args.project_id ?? '',
        scope: args.scope ?? '',
        depth_before: args.depth_before ?? 3,
        depth_after: args.depth_after ?? 3,
      }),
      presentCall: args => presentCall('Inspect memory timeline', args),
    }),
    detail: defineTool({
      name: 'cerebrate_detail',
      description: '【筛选后按需调用】渐进式披露第 3 层：按 ids 批量取完整详情（含 content/facts/concepts/evidence）。只对 search 筛选后确认相关的记忆调用，不要批量拉取所有结果。',
      parameters: {
        ids: { type: 'array', required: true, items: { type: 'string' }, description: '要取详情的记忆 ID 数组' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      execute: args => cerebrateRequest(config, 'POST', '/v1/memories/detail', { ids: args.ids }),
      presentCall: args => presentCall('Read memory details', args),
    }),
    query: defineTool({
      name: 'cerebrate_query',
      description: '【决策查询】返回完整内容 + 推荐动作（reuse/verify/new_experience）与 task 指令。\n【deprecated】读侧首选 cerebrate_search（索引层，省 token）；本工具保留给需要全文+决策的场景。\n决策矩阵:\n  recommendation=reuse (score>0.5) → 按 task.instructions 直接复用\n  recommendation=verify (score>0.2) → 参考后独立验证\n  recommendation=new_experience → 从零解决',
      parameters: {
        query: { type: 'string', required: true, description: '问题描述' },
        project_id: { type: 'string', description: '项目ID（可选）' },
        scope: { type: 'string', enum: ['', 'general', 'project', 'all'], description: '记忆分类' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      execute: args => cerebrateRequest(config, 'POST', '/v1/query', {
        query: args.query,
        user: config.user,
        agent_id: config.agentId,
        project_id: args.project_id ?? '',
        scope: args.scope ?? '',
        detail: true,
      }),
      presentCall: args => presentCall('Query memory decision', args),
    }),
    propose: defineTool({
      name: 'cerebrate_propose',
      description: '【解决问题后调用】提交新记忆到虫群（团队共享）。替代 v3 的 share。\nlife_stage 说明:\n  memory: 直接存入虫群(默认)\n  nutrient: 存入营养池，需共识投票升级为 memory',
      parameters: {
        title: { type: 'string', required: true, description: '记忆标题，一句话摘要' },
        content: { type: 'string', required: true, description: '详细内容：场景、排查、根因、方案、验证、命令' },
        problem: { type: 'string', required: true, description: '原始问题' },
        solution: { type: 'string', required: true, description: '一句话方案' },
        tags: { type: 'string', description: '逗号分隔的标签' },
        category: { type: 'string', enum: ['coding', 'debugging', 'architecture', 'devops', 'performance', 'security', 'testing', 'config', 'skill'], description: '分类' },
        project_id: { type: 'string', description: '项目ID（可选）；project 专属经验建议带上' },
        scope: { type: 'string', enum: ['', 'general', 'project'], description: '记忆分类: general=通用记忆; project=项目记忆（默认按 project_id 推断）' },
        life_stage: { type: 'string', enum: ['memory', 'nutrient'], description: '记忆生命阶段' },
        confidence: { type: 'number', description: '信心分数 0-1' },
        validate: { type: 'boolean', description: '是否触发免疫验证' },
        supersedes: { type: 'string', description: '血缘关系：逗号分隔的被取代记忆ID列表' },
        observation_type: { type: 'string', description: '观察类型: bugfix/decision/refactor/discovery/optimization/how-it-works/gotcha/problem-solution' },
        facts: { type: 'string', description: '逗号分隔的事实清单（可选）' },
        concepts: { type: 'string', description: '逗号分隔的概念标签（可选）' },
        skill_markdown: { type: 'string', description: 'SKILL.md 全文（frontmatter+body），结构化技能资产' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      execute: args => cerebrateRequest(config, 'POST', '/v1/memories/propose', {
        title: args.title,
        content: args.content,
        category: args.category ?? 'general',
        tags: args.tags ?? '',
        agent_id: config.agentId,
        problem: args.problem,
        solution: args.solution,
        life_stage: args.life_stage ?? 'memory',
        confidence: args.confidence ?? 1.0,
        validate: args.validate ?? true,
        project_id: args.project_id ?? '',
        scope: args.scope ?? '',
        supersedes: args.supersedes ?? '',
        observation_type: args.observation_type ?? '',
        facts: args.facts ?? '',
        concepts: args.concepts ?? '',
        skill_markdown: args.skill_markdown ?? '',
        physical_user: os.userInfo().username,
      }),
      presentCall: args => presentCall('Propose team memory', args),
    }),
    recall: defineTool({
      name: 'cerebrate_recall',
      description: '【会话开始调用】读取个人偏好和上下文缓存。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      execute: () => cerebrateRequest(config, 'GET', '/v1/personal'),
      presentCall: () => presentCall('Recall personal preferences', {}),
    }),
    remember: defineTool({
      name: 'cerebrate_remember',
      description: '【学到偏好时调用】写入个人偏好: user/key/value。',
      parameters: {
        key: { type: 'string', required: true, description: '偏好键名' },
        value: { type: 'string', required: true, description: '偏好值' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      execute: args => cerebrateRequest(config, 'POST', '/v1/personal', {
        user: config.user,
        key: args.key,
        value: args.value,
      }),
      presentCall: args => presentCall('Remember personal preference', args),
    }),
    stats: defineTool({
      name: 'cerebrate_stats',
      description: '查看虫群系统统计信息：记忆数、代理数、共识状态等。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderEnvelope },
      async execute() {
        const envelope = await cerebrateRequest(config, 'GET', '/v1/sense')
        if (envelope.status !== 'ok') return envelope
        const sense = envelope.data as unknown as {
          total_memories?: number
          total_agents?: number
          agent_ids?: JsonValue[]
          warnings?: JsonValue[]
          llm?: JsonValue
          consensus?: JsonValue
          health?: string
        } | undefined
        const data: EnvelopeValue = {
          total_memories: sense?.total_memories ?? 0,
          total_agents: sense?.total_agents ?? 0,
          agent_ids: sense?.agent_ids ?? [],
          warnings: sense?.warnings ?? [],
          health: sense?.health ?? 'unknown',
          ...(sense?.llm !== undefined ? { llm: sense.llm } : {}),
          ...(sense?.consensus !== undefined ? { consensus: sense.consensus } : {}),
        }
        return { status: 'ok', data }
      },
      presentCall: () => presentCall('Swarm statistics', {}),
    }),
  }
  for (const tool of Object.values(tools)) ctx.tools.register(tool)

  if (config.injectMemoryGuidance) {
    ctx.on('agent/pre-step', async (
      { agent, messages, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (guidanceAlreadyInjected(agent)) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text', text: MEMORY_GUIDANCE }],
        source: { kind: PRODUCER_KIND, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

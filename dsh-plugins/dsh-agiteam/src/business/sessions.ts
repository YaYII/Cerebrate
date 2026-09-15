/**
 * 角色会话管理 —— taskboard 风格：随机唯一 sessionId + 记录 + resume 续接。
 *
 * 为什么必须随机唯一 + 记录（修复 dsh 崩溃根因）：
 *  harness 的会话存储有硬校验：同 id 会话已存在时直接抛错
 *  （会话准备阶段：id 已注册即拒绝）。
 *  且会话持久化后端在磁盘已有同名日志时拒绝物化
 *  （提示用 load/resume 续接而不是重建）。
 *  旧实现用固定 id（session-<project>-<role>），进程重启后：
 *   1. agents.create() 复用旧 id → 直接抛 already exists → 崩溃；
 *   2. 同一项目新需求 R-2 复用 session-<project>-requirement，
 *      followup() 把 R-2 内容追加进 R-1 旧对话 → "两个对话内容"。
 *
 * 本模块的方案（抄袭 taskboard 的 execution/index.ts）：
 *  - 每个任务（角色×阶段）首次创建时生成随机 sessionId（agiteam-<uuid>），
 *    并记录到任务记录（tasks.sessionId）；
 *  - 之后唤醒同一任务：先 agents.get() 命中活会话 → followup；
 *    否则 agents.resume({ resumeSessionId: 记录值 }) 续接持久化会话
 *    （不 create，天然避开 already exists 崩溃）；
 *  - resume 失败（持久化被清/损坏）→ 新建随机 id 并更新任务记录；
 *  - 不同任务 = 不同 sessionId = 不同对话，绝不串内容。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** 角色会话身份（与任务记录关联）。 */
export interface RoleSessionIdentity {
  /** 项目 id。 */
  projectId: string
  /** 角色。 */
  role: string
  /** 需求 id（可选，需求×阶段专属会话）。 */
  reqId?: string
  /** 阶段（可选）。 */
  stage?: string
}

/** 模型配置（继承主会话，避免"无 provider/model"启动失败）。 */
export interface ModelOptions {
  provider?: string
  model?: string
  effort?: string
}

/** 会话管理所需的服务（收口窄接口，便于测试）。 */
export interface SessionServices {
  agents: {
    get(id: SessionId): { followup(msg: unknown): void } | undefined
    create(opts: {
      sessionId: SessionId
      meta?: { cwd?: string; agentPreset?: string; [key: string]: string | undefined }
      agentOptions?: Record<string, string>
      setup?(agentCtx: unknown): Promise<void>
    }): Promise<{ agent: { followup(msg: unknown): void; session?: { id?: string } } }>
    resume(opts: {
      resumeSessionId: SessionId
      agentOptions?: Record<string, string>
      setup?(agentCtx: unknown): Promise<void>
    }): Promise<{ agent: { followup(msg: unknown): void; session?: { id?: string } } }>
  }
  agentPresets: {
    resolve(id: string): Promise<unknown>
    mount(agentCtx: unknown, id: string): Promise<unknown>
  }
  workspaceRegistry?: {
    resolveByPath(path: string): Promise<{ attachSession(sid: string): Promise<void> } | undefined>
  }
}

/** 从 Cordis Context 读取会话管理服务。 */
export function sessionServicesFromCtx(ctx: Context): SessionServices {
  const services: SessionServices = {
    agents: ctx.get('agents') as SessionServices['agents'],
    agentPresets: ctx.get('agentPresets') as SessionServices['agentPresets'],
  }
  const workspaceRegistry = ctx.get('workspaceRegistry') as SessionServices['workspaceRegistry'] | undefined
  if (workspaceRegistry) services.workspaceRegistry = workspaceRegistry
  return services
}

/** 角色 → preset id（与 roles.ts 一致，避免循环依赖）。 */
const ROLE_PRESET: Record<string, string> = {
  supervisor: 'agiteam-supervisor',
  requirement: 'agiteam-requirement',
  architect: 'agiteam-architect',
  product: 'agiteam-product',
  'req-reviewer': 'agiteam-req-reviewer',
  'prod-reviewer': 'agiteam-prod-reviewer',
  'test-designer': 'agiteam-test-designer',
  developer: 'agiteam-developer',
  tester: 'agiteam-tester',
}

/** 构造随机唯一角色会话 id（taskboard 模式：每个任务一个，绝不复用旧 id）。 */
export function randomRoleSessionId(): SessionId {
  return `agiteam-${randomUUID()}` as SessionId
}

/** 从调用方会话继承模型配置（provider/model/effort）。 */
function inheritModel(ctx: Context, modelOpts?: ModelOptions): Record<string, string> {
  const callerAgent = (ctx as {
    agent?: {
      options?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
      session?: { requestHeader?(): { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined }
    }
  }).agent
  const headerConfig = callerAgent?.session?.requestHeader?.()?.config
  const srcProvider = modelOpts?.provider || headerConfig?.provider || callerAgent?.options?.provider
  const srcModel = modelOpts?.model || headerConfig?.model || callerAgent?.options?.model
  const srcEffort = modelOpts?.effort || headerConfig?.reasoningEffort || callerAgent?.options?.reasoningEffort
  const out: Record<string, string> = {}
  if (srcProvider) out.provider = srcProvider
  if (srcModel) out.model = srcModel
  if (srcEffort) out.reasoningEffort = ReasoningEffortId(srcEffort)
  return out
}

/** 会话身份编码进 meta（可恢复归属）。 */
function identityMeta(identity: RoleSessionIdentity): Record<string, string> {
  const meta: Record<string, string> = {
    agiteamProjectId: identity.projectId,
    agiteamRole: identity.role,
  }
  if (identity.reqId) meta.agiteamReqId = identity.reqId
  if (identity.stage) meta.agiteamStage = identity.stage
  return meta
}

/** 从会话 meta 解码身份（undefined = 非 agiteam 会话）。 */
export function identityFromMeta(meta: Record<string, unknown> | undefined): RoleSessionIdentity | undefined {
  if (!meta || typeof meta.agiteamProjectId !== 'string' || typeof meta.agiteamRole !== 'string') return undefined
  const identity: RoleSessionIdentity = {
    projectId: meta.agiteamProjectId,
    role: meta.agiteamRole,
  }
  if (typeof meta.agiteamReqId === 'string') identity.reqId = meta.agiteamReqId
  if (typeof meta.agiteamStage === 'string') identity.stage = meta.agiteamStage
  return identity
}

/**
 * 确保角色会话就绪并投递引导消息。
 *
 * 续接顺序（taskboard 模式）：
 *  1. existingSessionId 且 agents.get() 命中活会话 → followup 投递；
 *  2. existingSessionId 且会话已持久化 → agents.resume() 续接同一对话；
 *  3. 无记录 / resume 失败 → 创建全新随机 id 会话（返回新 id 供调用方更新记录）。
 *
 * @param ctx 插件上下文（模型继承）
 * @param services 会话服务
 * @param identity 角色身份（meta 归属）
 * @param cwd 角色工作目录
 * @param greeting 引导消息
 * @param modelOpts 模型配置（可选）
 * @param existingSessionId 任务记录里的历史 sessionId（可选）
 * @returns 生效的 sessionId + 是否新建（新建时调用方应更新任务记录）
 */
export async function ensureRoleSession(
  ctx: Context,
  services: SessionServices,
  identity: RoleSessionIdentity,
  cwd: string,
  greeting: string,
  modelOpts?: ModelOptions,
  existingSessionId?: string,
): Promise<{ sessionId: SessionId; created: boolean }> {
  if (!services.agents || !services.agentPresets) throw new Error('agents/agentPresets 服务不可用')
  const presetId = ROLE_PRESET[identity.role]
  if (!presetId) throw new Error(`未知角色 ${identity.role}`)
  await services.agentPresets.resolve(presetId)
  const agentOptions = inheritModel(ctx, modelOpts)
  const setup = async (agentCtx: unknown): Promise<void> => {
    await services.agentPresets.mount(agentCtx, presetId)
  }

  // 归属工作区（会话就绪后 attach，保证侧边栏可见）
  const attach = async (sessionId: SessionId): Promise<void> => {
    if (!services.workspaceRegistry) return
    try {
      const ws = await services.workspaceRegistry.resolveByPath(cwd)
      if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sessionId)
    } catch { /* 归属失败不阻断 */ }
  }
  const greet = (agent: { followup(msg: unknown): void }): void => {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: greeting }],
      source: { kind: 'plugin', plugin: 'dsh-agiteam', form: 'instructions' },
    }))
  }

  // 1. 活会话命中：直接 followup（不 create、不 resume，无任何冲突）
  if (existingSessionId) {
    const live = services.agents.get(existingSessionId as SessionId)
    if (live && typeof live.followup === 'function') {
      console.error(`[dsh-agiteam] 角色会话命中活会话（role=${identity.role}, session=${existingSessionId}）`)
      greet(live)
      return { sessionId: existingSessionId as SessionId, created: false }
    }
    // 2. 尝试 resume 持久化会话（续接同一对话，天然避开 already exists 崩溃）
    try {
      const resumed = await services.agents.resume({
        resumeSessionId: existingSessionId as SessionId,
        agentOptions,
        setup,
      })
      if (resumed?.agent && typeof resumed.agent.followup === 'function') {
        const sid = (resumed.agent.session?.id ?? existingSessionId) as SessionId
        console.error(`[dsh-agiteam] 角色会话续接成功（role=${identity.role}, session=${sid}）`)
        greet(resumed.agent)
        await attach(sid)
        return { sessionId: sid, created: false }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[dsh-agiteam] 角色会话续接失败（role=${identity.role}, session=${existingSessionId}）: ${detail}，回退创建新会话`)
    }
  }

  // 3. 无记录 / 续接失败 → 创建全新随机 id 会话（绝不复用旧 id）
  const sessionId = randomRoleSessionId()
  const meta = {
    cwd,
    agentPreset: presetId,
    ...identityMeta(identity),
  }
  try {
    const handle = await services.agents.create({
      sessionId,
      meta,
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      setup,
    })
    if (!handle?.agent || typeof handle.agent.followup !== 'function') {
      throw new Error(`角色会话创建返回异常（sessionId=${sessionId}, preset=${presetId}, keys=${Object.keys(handle ?? {}).join(',') || '空'}）`)
    }
    console.error(`[dsh-agiteam] 角色会话创建成功（role=${identity.role}, session=${sessionId}, agentSession=${handle.agent.session?.id ?? '无'}）`)
    greet(handle.agent)
    await attach(sessionId)
    return { sessionId, created: true }
  } catch (err) {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    console.error(`[dsh-agiteam] 创建角色会话失败（role=${identity.role}, sessionId=${sessionId}, preset=${presetId}, cwd=${cwd}）:\n${detail}`)
    throw new Error(`创建角色会话失败（role=${identity.role}, sessionId=${sessionId}, cwd=${cwd}）：\n${detail}`)
  }
}

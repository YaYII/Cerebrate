/**
 * 团队开发编排引擎 —— 项目状态管理、阶段流转、角色 agent 创建与唤醒、
 * 产物落盘、评审门禁处理。
 *
 * 为什么独立成模块：编排是业务组合（组合 features 的纯能力 +
 * DSH 运行时服务），集中在这里，装配层只做工具注册。
 *
 * 核心设计（修复 pipeline-kernel 的两个缺陷）：
 *  1. 任务"有内容"：每个阶段产物（需求清单/功能清单/用例矩阵/验收报告）
 *     渲染为 Markdown 直接落盘 artifactsDir，并作为引导消息内容
 *     投递给对应角色 agent（而非只有标题）。
 *  2. 有业务门禁：评审阶段（req-review/product-review/testcase-review）
 *     由评审角色判定 pass/打回；打回自动回到上一阶段带意见重做。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { nextStage, reviewBackTo, STAGE_NAMES, type StageId } from '../features/stage'
import type { TeamProjectState } from '../features/model'
import { parseAuditLog, makeAuditEntry } from '../features/audit'
import { ROLE_NAMES, ROLE_PRESET, STAGE_ROLE, type TeamRole } from './roles'

/** 审计日志文件名（追加式 JSONL，链式哈希防篡改）。 */
export const AUDIT_FILE = 'audit.jsonl'

/** 插件配置（与装配层共享）。 */
export interface AgiteamConfig {
  /** 产物目录名（相对项目 cwd）。 */
  artifactsDir: string
  /** 是否注入阶段引导。 */
  injectGuidance: boolean
}

/** 项目状态文件名。 */
export const STATE_FILE = 'state.json'

/** 阶段产物文件名映射（stage → 文件名）。 */
export const STAGE_ARTIFACT_FILE: Partial<Record<StageId, string>> = {
  requirement: 'requirements.md',
  'req-review': 'req-review.md',
  product: 'features.md',
  'product-review': 'product-review.md',
  testcase: 'testcases.md',
  'testcase-review': 'testcase-review.md',
  develop: 'development.md',
  'feature-accept': 'acceptance.md',
  'e2e-accept': 'e2e.md',
}

/** 引擎依赖的 DSH 运行时能力（收口为窄接口，便于测试）。 */
export interface EngineRuntime {
  /** 读取文本文件（相对 cwd）。不存在返回 undefined。 */
  readText(relPath: string): Promise<string | undefined>
  /** 写文本文件（相对 cwd，自动建目录）。 */
  writeText(relPath: string, content: string): Promise<void>
  /** 判断文件/目录是否存在。 */
  exists(relPath: string): Promise<boolean>
  /** 列出目录条目。 */
  listDir(relPath: string): Promise<string[]>
  /** 创建角色 agent（会话 id 稳定：session-<project>-<role>）。 */
  createRoleAgent(projectId: string, role: TeamRole, cwd: string, greeting: string): Promise<{ sessionId: string }>
  /** 唤醒已存在的角色 agent（投递一条消息）。 */
  wakeRoleAgent(projectId: string, role: TeamRole, text: string): Promise<boolean>
  /** 追加一条审计日志（链式哈希，防篡改）。返回新条目的 seq 与 hash。 */
  appendAudit(input: {
    projectId: string
    role: string
    stage: string
    action: string
    detail: string
    fingerprint?: string
  }): Promise<{ seq: number; hash: string }>
}

/** 从 Cordis Context 构造运行时（装配层调用）。 */
export function runtimeFromCtx(ctx: Context, cwd: string): EngineRuntime {
  // dsh-fs 契约：resolve(path) → FsTarget，再 stat/readText/writeText/listDir(target)
  const fs = ctx.get('fs') as {
    resolve(path: string): Promise<{ targetKey: string; displayPath: string }>
    stat(target: { targetKey: string; displayPath: string }): Promise<{ type: string; version: string; size?: number } | undefined>
    readText(target: { targetKey: string; displayPath: string }): Promise<string>
    writeText(target: { targetKey: string; displayPath: string }, content: string): Promise<unknown>
    listDir(target: { targetKey: string; displayPath: string }): Promise<{ name: string; type: string; target: unknown }[]>
  } | undefined
  const agents = ctx.get('agents')
  const agentPresets = ctx.get('agentPresets')
  const workspaceRegistry = ctx.get('workspaceRegistry')

  /** 拼接 cwd 相对路径（防路径穿越）。 */
  const join = (rel: string): string => {
    const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    return `${cwd.replace(/\/+$/, '')}/${normalized}`
  }

  return {
    async readText(relPath) {
      if (!fs) return undefined
      try {
        // dsh-fs 契约：resolve(path) → target，再 readText(target)
        const target = await fs.resolve(join(relPath))
        return await fs.readText(target)
      } catch {
        return undefined
      }
    },
    async writeText(relPath, content) {
      if (!fs) throw new Error('fs 服务不可用')
      // dsh-fs 契约：resolve(path) → target，再 writeText(target, content)
      const target = await fs.resolve(join(relPath))
      await fs.writeText(target, content)
    },
    async exists(relPath) {
      if (!fs) return false
      try {
        const target = await fs.resolve(join(relPath))
        const info = await fs.stat(target)
        return info !== undefined
      } catch {
        return false
      }
    },
    async listDir(relPath) {
      if (!fs) return []
      try {
        const target = await fs.resolve(join(relPath))
        const entries = await fs.listDir(target)
        return entries.map((e: { name: string }) => e.name)
      } catch {
        return []
      }
    },
    async createRoleAgent(projectId, role, roleCwd, greeting) {
      if (!agents || !agentPresets) throw new Error('agents/agentPresets 服务不可用')
      // taskboard 模式：随机唯一 id（绝不复用旧 id，避免 session already exists 崩溃）
      const sessionId = `agiteam-fallback-${projectId}-${role}-${randomUUID()}` as SessionId
      const presetId = ROLE_PRESET[role]
      try {
        // 校验 preset 存在
        await agentPresets.resolve(presetId)
        // 官方播种配方：create + meta.agentPreset + setup mount
        // agentOptions 继承调用方会话模型（避免"无 provider/model"启动失败）。
        // 官方配方（resolveChildAgentOptions）：优先读父会话 requestHeader 实际使用的模型
        const caller = (ctx as {
          agent?: {
            options?: { provider?: string; model?: string; reasoningEffort?: string }
            session?: { requestHeader?(): { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined }
          }
        }).agent
        const headerConfig = caller?.session?.requestHeader?.()?.config
        const agentOptions: Record<string, string> = {}
        if (headerConfig?.provider || caller?.options?.provider) agentOptions.provider = headerConfig?.provider ?? caller?.options?.provider ?? ''
        if (headerConfig?.model || caller?.options?.model) agentOptions.model = headerConfig?.model ?? caller?.options?.model ?? ''
        if (headerConfig?.reasoningEffort || caller?.options?.reasoningEffort) {
          agentOptions.reasoningEffort = ReasoningEffortId(headerConfig?.reasoningEffort ?? caller?.options?.reasoningEffort ?? '')
        }
        console.error(`[dsh-agiteam] createRoleAgent 模型继承（${role}）：provider=${agentOptions.provider ?? '无'}, model=${agentOptions.model ?? '无'}`)
        const createOptions: Parameters<typeof agents.create>[0] = {
          sessionId,
          meta: { cwd: roleCwd, agentPreset: presetId },
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          setup: async (agentCtx: Context) => {
            await agentPresets.mount(agentCtx, presetId)
          },
        }
        const handle = await agents.create(createOptions)
        // 首条引导消息：让角色会话非 blank 且带内容
        const live = handle.agent
        if (live && typeof live.followup === 'function') {
          live.followup(createUserMessage({
            content: [{ type: 'text', text: greeting }],
            source: { kind: 'plugin', plugin: 'dsh-agiteam', form: 'instructions' },
          }))
        }
        // 归属工作区
        if (workspaceRegistry) {
          try {
            const ws = await workspaceRegistry.resolveByPath(roleCwd)
            if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sessionId)
          } catch { /* 归属失败不阻断 */ }
        }
        return { sessionId }
      } catch (err) {
        // 透传带完整现场的错误信息（message + stack），工具层可读；同时打日志到 dsh stdout
        const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
        console.error(`[dsh-agiteam] createRoleAgent 失败（role=${role}, sessionId=${sessionId}, preset=${presetId}, cwd=${roleCwd}）:\n${detail}`)
        throw new Error(`创建角色会话失败（role=${role}, sessionId=${sessionId}, cwd=${roleCwd}）：\n${detail}`)
      }
    },
    async wakeRoleAgent(projectId, role, text) {
      if (!agents) return false
      const sessionId = `session-${projectId}-${role}` as SessionId
      const live = agents.get(sessionId)
      if (!live || typeof live.followup !== 'function') return false
      live.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-agiteam', form: 'instructions' },
      }))
      return true
    },
    async appendAudit(input) {
      const auditFile = `${input.projectId}/${AUDIT_FILE}`
      const auditText = await this.readText(auditFile)
      const entries = auditText ? parseAuditLog(auditText) : []
      const prevHash = entries.length > 0 ? entries[entries.length - 1]!.hash : 'GENESIS'
      const entry = makeAuditEntry(entries.length + 1, {
        time: Date.now(),
        action: input.action,
        role: input.role,
        projectId: input.projectId,
        stage: input.stage,
        detail: input.detail,
        ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
      }, prevHash)
      const nextText = auditText ? `${auditText}\n${JSON.stringify(entry)}` : JSON.stringify(entry)
      await this.writeText(auditFile, nextText)
      return { seq: entry.seq, hash: entry.hash }
    },
  }
}

/** 构造空项目状态。 */
export function emptyState(projectId: string, projectName: string, rawRequirement: string, cwd: string): TeamProjectState {
  return {
    projectId,
    projectName,
    rawRequirement,
    stage: 'requirement',
    completed: {},
    reviewComments: {},
    artifacts: {},
    cwd,
    updatedAt: Date.now(),
  }
}

/** 读取项目状态；不存在返回 undefined。 */
export async function loadState(rt: EngineRuntime, projectId: string): Promise<TeamProjectState | undefined> {
  const text = await rt.readText(`${projectId}/${STATE_FILE}`)
  if (!text) return undefined
  try {
    return JSON.parse(text) as TeamProjectState
  } catch {
    return undefined
  }
}

/** 保存项目状态。 */
export async function saveState(rt: EngineRuntime, state: TeamProjectState): Promise<void> {
  state.updatedAt = Date.now()
  await rt.writeText(`${state.projectId}/${STATE_FILE}`, JSON.stringify(state, null, 2))
}

/** 记录评审意见。 */
export async function recordReviewComment(state: TeamProjectState, stage: string, comment: string): Promise<void> {
  const list = state.reviewComments[stage] ?? []
  list.push(comment)
  state.reviewComments[stage] = list
}

/**
 * 推进阶段（正常流转或评审打回）。
 *  - 正常：stage → nextStage
 *  - 评审不通过：stage → reviewBackTo（回到上一阶段）
 * @returns 新阶段 id。
 */
export function advanceStage(state: TeamProjectState, passed: boolean): StageId {
  const current = state.stage as StageId
  if (!passed && reviewBackTo(current)) {
    const back = reviewBackTo(current)!
    state.stage = back
    return back
  }
  const next = nextStage(current)
  if (next) state.stage = next
  return state.stage as StageId
}

/** 阶段 → 角色引导消息（投递给负责角色，含产物内容回灌对话）。 */
export function stageGreeting(state: TeamProjectState, stage: string, artifactText?: string): string {
  const name = STAGE_NAMES[stage as StageId] ?? stage
  const role = STAGE_ROLE[stage] as TeamRole | undefined
  const roleName = role ? ROLE_NAMES[role] : '对应角色'
  const base = [
    `【dsh-agiteam】项目「${state.projectName}」进入阶段：${name}。`,
    `你作为${roleName}，请完成本阶段工作。`,
  ]
  if (artifactText) base.push('', '以下是本阶段依据/产物：', '', artifactText)
  base.push('', '完成后请汇报结论；若你是评审角色，请给出明确 通过/打回 判定与意见。')
  return base.join('\n')
}

/**
 * 启动一个新团队开发项目。
 * @returns 新项目状态。
 */
export async function startProject(
  rt: EngineRuntime,
  projectId: string,
  projectName: string,
  rawRequirement: string,
  cwd: string,
): Promise<TeamProjectState> {
  const state = emptyState(projectId, projectName, rawRequirement, cwd)
  // 建目录 + 写初始状态
  await rt.writeText(`${projectId}/${STATE_FILE}`, JSON.stringify(state, null, 2))
  // 唤醒需求分析师开始第一阶段
  const greeting = stageGreeting(state, 'requirement', rawRequirement)
  await rt.createRoleAgent(projectId, 'requirement', cwd, greeting)
  return state
}

/**
 * 推进当前阶段到下一阶段（或打回），并唤醒对应角色 agent 继续工作。
 * @returns 更新后的状态。
 */
export async function advanceAndWake(
  rt: EngineRuntime,
  state: TeamProjectState,
  passed: boolean,
  comment?: string,
): Promise<TeamProjectState> {
  if (comment) await recordReviewComment(state, state.stage, comment)
  const next = advanceStage(state, passed)
  await saveState(rt, state)
  // 读取产物回灌对话（有内容）
  const artifactFile = STAGE_ARTIFACT_FILE[next]
  const artifactText = artifactFile ? await rt.readText(`${state.projectId}/${artifactFile}`) : undefined
  const role = STAGE_ROLE[next] as TeamRole | undefined
  if (role) {
    const greeting = stageGreeting(state, next, artifactText)
    const woken = await rt.wakeRoleAgent(state.projectId, role, greeting)
    if (!woken) {
      // 会话不存在（如重启后）→ 重建
      await rt.createRoleAgent(state.projectId, role, state.cwd, greeting)
    }
  }
  return state
}

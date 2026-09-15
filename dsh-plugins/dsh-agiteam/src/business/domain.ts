/**
 * dsh-agiteam 存储域 —— 基于官方 storageDomain（JSON 后端）的数据库持久化。
 *
 * 为什么用 storageDomain 而非文件系统：pipeline-kernel 同款官方机制，
 * 数据可靠落盘、可查询、可追溯（替代 .teamdev/ 的散落 JSON 文件）。
 *
 * 表结构：
 *  projects  (key=projectId)  项目状态（阶段/评审意见/产物映射/追溯实体汇总）
 *  entities  (key=实体id)     追溯实体（需求/功能/用例/单测/代码/脚本）
 *  audit     (key=seq)        审计日志（链式哈希防篡改）
 *  tasks     (key=taskId)     阶段任务（执行角色/状态/结果）
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** 项目状态记录（projects 表行）。 */
export const ProjectRecord = z.object({
  id: z.string(),
  name: z.string(),
  rawRequirement: z.string().default(''),
  stage: z.string().default('requirement'),
  completed: z.record(z.string(), z.boolean()).default({}),
  reviewComments: z.record(z.string(), z.array(z.string())).default({}),
  artifacts: z.record(z.string(), z.string()).default({}),
  cwd: z.string().default(''),
  /** 自动驱动标志：true = 阶段完成自动推进。 */
  autoDrive: z.boolean().default(true),
  /** 当前处理中的需求 id（需求×阶段专属会话）。 */
  currentReqId: z.string().default(''),
  /** 项目内需求列表（reqId → 标题）。 */
  requirements: z.record(z.string(), z.string()).default({}),
  /** 发起项目的主会话 id（角色完成时通知该会话继续指挥）。 */
  ownerSession: z.string().default(''),
  /** 知识库相对路径（团队知识库/<项目>/<需求大类>/<具体需求>/），用于 Obsidian 落盘。 */
  kbPath: z.string().default(''),
  /** 主会话 provider（角色 agent 继承，避免"无 provider/model"启动失败）。 */
  ownerProvider: z.string().default(''),
  /** 主会话 model。 */
  ownerModel: z.string().default(''),
  /** 主会话 reasoning effort。 */
  ownerEffort: z.string().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** 追溯实体记录（entities 表行，key = `${projectId}:${type}:${id}`）。 */
export const EntityRecord = z.object({
  /** 实体 id（R-1/F-1/TC-1/UT-1/CF-1/AS-1）。 */
  id: z.string(),
  /** 实体类型：requirement/feature/testcase/unittest/codefile/script。 */
  type: z.enum(['requirement', 'feature', 'testcase', 'unittest', 'codefile', 'script']),
  /** 关联项目 id。 */
  projectId: z.string(),
  /** 实体数据（JSON 字符串）。 */
  data: z.string(),
  /** 关联关系（如 feature → requirementIds，testcase → featureId）。 */
  refs: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  /** 状态（passed/pending/failed）。 */
  status: z.enum(['passed', 'pending', 'failed']).default('pending'),
  /** 登记时间。 */
  createdAt: z.number(),
  /** 更新时间。 */
  updatedAt: z.number(),
})

/** 审计日志记录（audit 表行，key = `${projectId}:${seq}`）。 */
export const AuditRecord = z.object({
  seq: z.number(),
  projectId: z.string(),
  time: z.number(),
  action: z.string(),
  role: z.string(),
  stage: z.string().default(''),
  detail: z.string().default(''),
  fingerprint: z.string().optional(),
  /** 链式哈希防篡改。 */
  prevHash: z.string(),
  hash: z.string(),
})

/** 任务板状态：待处理/已认领/进行中/待审批/已暂停/已完成/已失败/已打回。 */
export const TASK_STATUSES = ['open', 'claimed', 'in_progress', 'in_review', 'paused', 'done', 'failed', 'rejected'] as const
export type TaskStatus = typeof TASK_STATUSES[number]

/** 审批来源：人工直接批准 / AI 代为审批（建议）/ 自动放行。 */
export type ApprovalSource = 'human' | 'ai' | 'auto'

/** 阶段任务记录（tasks 表行，key = `${projectId}:${taskId}`）。 */
export const TaskRecord = z.object({
  id: z.string(),
  projectId: z.string(),
  stage: z.string(),
  title: z.string(),
  /** 执行角色。 */
  role: z.string(),
  /** 任务状态（任务板七状态机）。 */
  status: z.enum(TASK_STATUSES).default('open'),
  /** 执行会话 id（随机唯一，taskboard 模式；重启后可 resume 续接）。 */
  sessionId: z.string().default(''),
  /** 认领者（会话 id，兼容旧字段）。 */
  claimedBy: z.string().optional(),
  /** 完成结果。 */
  result: z.string().default(''),
  /** 审批建议（AI 代审批时提交，人工可采纳/驳回）。 */
  approvalSuggestion: z.string().default(''),
  /** 审批来源：human（人工批准）/ ai（AI 代为审批）/ auto（自动放行）。 */
  approvalSource: z.enum(['human', 'ai', 'auto']).default('human'),
  /** 审批时间。 */
  approvedAt: z.number().optional(),
  /** 审批意见（打回/暂停原因）。 */
  reviewComment: z.string().default(''),
  /** 是否人工暂停（随时可暂停任务）。 */
  pausedByHuman: z.boolean().default(false),
  /** 暂停原因。 */
  pauseReason: z.string().default(''),
  /** 创建时间。 */
  createdAt: z.number(),
  /** 更新时间。 */
  updatedAt: z.number(),
})

/** agiteam 存储域定义（tables + version）。 */
export const agiteamDomain = defineDomain({
  name: 'agiteam',
  version: 1,
  tables: {
    projects: domainTable(ProjectRecord),
    entities: domainTable(EntityRecord),
    audit: domainTable(AuditRecord),
    tasks: domainTable(TaskRecord),
  },
})

/** 各表的行类型（zod 推断）。 */
export type ProjectRecordType = z.infer<typeof ProjectRecord>
export type EntityRecordType = z.infer<typeof EntityRecord>
export type AuditRecordType = z.infer<typeof AuditRecord>
export type TaskRecordType = z.infer<typeof TaskRecord>

/** 从域表构造复合 key。 */
export function entityKey(projectId: string, type: string, id: string): string {
  return `${projectId}:${type}:${id}`
}

export function auditKey(projectId: string, seq: number): string {
  return `${projectId}:${seq}`
}

export function taskKey(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}`
}

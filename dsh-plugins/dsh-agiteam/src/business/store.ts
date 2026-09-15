/**
 * dsh-agiteam 存储访问层 —— 基于 storageDomain 的数据库 CRUD。
 *
 * 封装域的打开与项目/实体/审计/任务的读写，业务层通过本层访问数据，
 * 不直接碰 storageDomain。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { agiteamDomain, entityKey, auditKey, taskKey } from './domain'
import type {
  ProjectRecordType as ProjectRecord,
  EntityRecordType as EntityRecord,
  AuditRecordType as AuditRecord,
  TaskRecordType as TaskRecord,
} from './domain'

/** 打开的 agiteam 域句柄。 */
export interface AgiteamDomain {
  /** 域句柄。 */
  handle: Domain<typeof agiteamDomain>
  /** 项目表。 */
  projects: ReturnType<Domain<typeof agiteamDomain>['table']>
  /** 实体表。 */
  entities: ReturnType<Domain<typeof agiteamDomain>['table']>
  /** 审计表。 */
  audit: ReturnType<Domain<typeof agiteamDomain>['table']>
  /** 任务表。 */
  tasks: ReturnType<Domain<typeof agiteamDomain>['table']>
}

/**
 * 打开 agiteam 存储域（幂等：已打开则复用）。
 * @param ctx 插件上下文
 * @returns 域句柄（调用方负责在 effect 中关闭）
 */
export async function openAgiteamDomain(ctx: Context): Promise<AgiteamDomain> {
  const storageDomain = ctx.get('storageDomain') as {
    open(spec: unknown): Promise<Domain<typeof agiteamDomain>>
    get(name: string): unknown
  } | undefined
  if (!storageDomain) throw new Error('storageDomain 服务不可用（需要 host 提供）')

  // 幂等：已打开则复用现有句柄
  const existing = storageDomain.get('agiteam') as Domain<typeof agiteamDomain> | undefined
  if (existing) {
    return {
      handle: existing,
      projects: existing.table('projects'),
      entities: existing.table('entities'),
      audit: existing.table('audit'),
      tasks: existing.table('tasks'),
    }
  }

  const handle = await storageDomain.open(agiteamDomain)
  return {
    handle,
    projects: handle.table('projects'),
    entities: handle.table('entities'),
    audit: handle.table('audit'),
    tasks: handle.table('tasks'),
  }
}

// ── 项目 CRUD ──

/** 创建/更新项目。 */
export async function upsertProject(domain: AgiteamDomain, record: ProjectRecord): Promise<void> {
  await domain.projects.put(record.id, record)
}

/** 读取项目；不存在返回 undefined。 */
export function getProject(domain: AgiteamDomain, projectId: string): ProjectRecord | undefined {
  return domain.projects.get(projectId)
}

/** 列出全部项目。 */
export function listProjects(domain: AgiteamDomain): ProjectRecord[] {
  return [...domain.projects.entries()].map(([, v]) => v)
}

// ── 实体 CRUD ──

/** 登记/更新追溯实体。 */
export async function upsertEntity(domain: AgiteamDomain, record: EntityRecord): Promise<void> {
  await domain.entities.put(entityKey(record.projectId, record.type, record.id), record)
}

/** 读取实体。 */
export function getEntity(domain: AgiteamDomain, projectId: string, type: string, id: string): EntityRecord | undefined {
  return domain.entities.get(entityKey(projectId, type, id))
}

/** 列出项目全部实体（按类型过滤可选）。 */
export function listEntities(domain: AgiteamDomain, projectId: string, type?: string): EntityRecord[] {
  return [...domain.entities.entries()]
    .filter(([k, v]) => k.startsWith(`${projectId}:`) && (type === undefined || v.type === type))
    .map(([, v]) => v)
}

// ── 审计 CRUD ──

/** 追加审计记录（链式哈希）。返回完整记录。 */
export async function appendAuditRecord(domain: AgiteamDomain, record: AuditRecord): Promise<AuditRecord> {
  await domain.audit.put(auditKey(record.projectId, record.seq), record)
  return record
}

/** 读取项目最近 N 条审计（按 seq 排序）。 */
export function listAudit(domain: AgiteamDomain, projectId: string, limit = 200): AuditRecord[] {
  return [...domain.audit.entries()]
    .filter(([k]) => k.startsWith(`${projectId}:`))
    .map(([, v]) => v)
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit)
}

/** 读取审计链末条（用于计算 prevHash）。 */
export function lastAudit(domain: AgiteamDomain, projectId: string): AuditRecord | undefined {
  const all = [...domain.audit.entries()]
    .filter(([k]) => k.startsWith(`${projectId}:`))
    .map(([, v]) => v)
    .sort((a, b) => a.seq - b.seq)
  return all.length > 0 ? all[all.length - 1] : undefined
}

// ── 任务 CRUD ──

/** 创建/更新阶段任务。 */
export async function upsertTask(domain: AgiteamDomain, record: TaskRecord): Promise<void> {
  await domain.tasks.put(taskKey(record.projectId, record.id), record)
}

/** 读取项目任务（按状态过滤可选）。 */
export function listTasks(domain: AgiteamDomain, projectId: string, status?: TaskRecord['status']): TaskRecord[] {
  return [...domain.tasks.entries()]
    .filter(([k, v]) => k.startsWith(`${projectId}:`) && (status === undefined || v.status === status))
    .map(([, v]) => v)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 读取项目当前阶段任务（open/claimed）。 */
export function openTasks(domain: AgiteamDomain, projectId: string): TaskRecord[] {
  return listTasks(domain, projectId).filter(t => t.status === 'open' || t.status === 'claimed')
}

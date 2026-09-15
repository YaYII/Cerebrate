/**
 * taskboard 底座衔接层 —— dsh-agiteam（AGI 团队大脑）与 taskboard（成熟底座）的桥梁。
 *
 * 为什么用 createRequire 动态加载：
 *  dsh-agiteam 独立构建（ESM），运行时从 profile 的 node_modules 解析
 *  `@shengsheng/dsh-taskboard`（v0.1.4，Apache-2.0）。Node 模块解析
 *  从 dsh-agiteam 真实路径向上找不到该包，必须用 createRequire 锚定
 *  profile 的 package.json 来解析。这样：
 *   1. 不复制 taskboard 源码（避免依赖坑/tsconfig 冲突）；
 *   2. taskboard 的成熟 UI（SQLite 权威 + 乐观锁 + change-watch）原样可用；
 *   3. 我们只在它的领域层之上叠加 AGI 团队流程。
 *
 * 核心能力（taskboard provider 的 93 个方法，这里收口为 AGI 层需要的窄接口）：
 *  - createProject / createTask：AGI 团队项目与阶段任务
 *  - claim / submitReview / approve / moveStatus：任务板状态机 + 人工审批
 *  - source 字段：承载 AGI 阶段（stage/requirement/role/artifactPath）
 */

import { createRequire } from 'node:module'

/** profile 的 package.json 绝对路径（taskboard 安装于此）。 */
const PROFILE_PKG = '/home/as-workstation01/.dsh/profiles/web/package.json'

/** 惰性加载 taskboard 模块（首次调用时解析，缓存句柄）。 */
let cached: TaskboardBridgeApi | undefined

/** taskboard 衔接层的运行时 API（从已装包解构，类型用 any 收口避免 d.ts 依赖）。 */
export interface TaskboardBridgeApi {
  /** SqliteTaskboardProvider 构造器。 */
  SqliteTaskboardProvider: new (path: string, options?: Record<string, unknown>) => unknown
  /** 领域工具。 */
  ProjectId: (id: string) => string
  TaskId: (id: string) => string
  TaskboardError: new (message: string, code?: string) => Error
  TASK_STATUSES: readonly string[]
  requireHuman: (actor: unknown, op: string) => void
  isHumanOnlyOperation: (op: string) => boolean
  parseTaskStatus: (status: string) => string
  /** 自动化协调器（调度 agent 认领任务）。 */
  TaskboardAutomationCoordinator: new (...args: unknown[]) => unknown
  /** Harness worker（随机 sessionId + resume 续接）。 */
  HarnessTaskboardWorker: new (...args: unknown[]) => unknown
}

/** 从 profile 解析 taskboard 包（首次调用缓存）。 */
export function loadTaskboard(): TaskboardBridgeApi {
  if (cached) return cached
  const requireFromProfile = createRequire(PROFILE_PKG)
  const domain = requireFromProfile('@shengsheng/dsh-taskboard/domain') as Record<string, unknown>
  const root = requireFromProfile('@shengsheng/dsh-taskboard') as Record<string, unknown>
  const api: TaskboardBridgeApi = {
    SqliteTaskboardProvider: root.SqliteTaskboardProvider as TaskboardBridgeApi['SqliteTaskboardProvider'],
    ProjectId: domain.ProjectId as TaskboardBridgeApi['ProjectId'],
    TaskId: domain.TaskId as TaskboardBridgeApi['TaskId'],
    TaskboardError: domain.TaskboardError as TaskboardBridgeApi['TaskboardError'],
    TASK_STATUSES: domain.TASK_STATUSES as readonly string[],
    requireHuman: domain.requireHuman as TaskboardBridgeApi['requireHuman'],
    isHumanOnlyOperation: domain.isHumanOnlyOperation as TaskboardBridgeApi['isHumanOnlyOperation'],
    parseTaskStatus: domain.parseTaskStatus as TaskboardBridgeApi['parseTaskStatus'],
    TaskboardAutomationCoordinator: root.TaskboardAutomationCoordinator as TaskboardBridgeApi['TaskboardAutomationCoordinator'],
    HarnessTaskboardWorker: root.HarnessTaskboardWorker as TaskboardBridgeApi['HarnessTaskboardWorker'],
  }
  cached = api
  return api
}

/** 打开（或复用）taskboard SQLite 数据库。 */
export function openTaskboardDatabase(path: string, options?: Record<string, unknown>): unknown {
  const api = loadTaskboard()
  return new api.SqliteTaskboardProvider(path, options)
}

/** AGI 阶段任务写入 taskboard 的 source 字段（可被 UI 读取展示）。 */
export interface AgiteamTaskSource {
  /** 阶段 id（requirement/req-review/product/...）。 */
  stage: string
  /** 需求 id（可选）。 */
  requirementId?: string
  /** 角色（requirement/product/developer/...）。 */
  role?: string
  /** 产物相对路径（如 requirements/requirements.md）。 */
  artifactPath?: string
  /** 项目 cwd。 */
  cwd?: string
  /** 知识库路径。 */
  kbPath?: string
}

/** 从任务 source 解码 AGI 阶段信息（无则 undefined）。 */
export function agiteamSourceOf(source: Record<string, unknown> | undefined): AgiteamTaskSource | undefined {
  if (!source || typeof source.agiteamStage !== 'string') return undefined
  const out: AgiteamTaskSource = { stage: source.agiteamStage }
  if (typeof source.agiteamRequirementId === 'string') out.requirementId = source.agiteamRequirementId
  if (typeof source.agiteamRole === 'string') out.role = source.agiteamRole
  if (typeof source.agiteamArtifactPath === 'string') out.artifactPath = source.agiteamArtifactPath
  if (typeof source.agiteamCwd === 'string') out.cwd = source.agiteamCwd
  if (typeof source.agiteamKbPath === 'string') out.kbPath = source.agiteamKbPath
  return out
}

/** 编码 AGI 阶段信息进 source（供 createTask 用）。 */
export function encodeAgiteamSource(info: AgiteamTaskSource): Record<string, unknown> {
  return {
    agiteamStage: info.stage,
    ...(info.requirementId === undefined ? {} : { agiteamRequirementId: info.requirementId }),
    ...(info.role === undefined ? {} : { agiteamRole: info.role }),
    ...(info.artifactPath === undefined ? {} : { agiteamArtifactPath: info.artifactPath }),
    ...(info.cwd === undefined ? {} : { agiteamCwd: info.cwd }),
    ...(info.kbPath === undefined ? {} : { agiteamKbPath: info.kbPath }),
  }
}

/** 阶段 → taskboard 标签（UI 列筛选用）。 */
export function stageLabel(stage: string): string {
  return `stage:${stage}`
}

/** 阶段名 → 中文（供 UI 展示）。 */
export const AGITEAM_STAGE_NAMES: Record<string, string> = {
  requirement: '需求分析',
  'req-review': '需求评审',
  product: '产品设计',
  'product-review': '产品评审',
  testcase: '测试用例设计',
  'testcase-review': '测试用例评审',
  develop: '正式开发',
  'feature-accept': '逐功能验收',
  'e2e-accept': '端到端验收',
  done: '交付',
}

/** 阶段 → 角色（与 roles.ts 一致，避免循环依赖）。 */
export const AGITEAM_STAGE_ROLE: Record<string, string> = {
  requirement: 'requirement',
  'req-review': 'req-reviewer',
  product: 'product',
  'product-review': 'prod-reviewer',
  testcase: 'test-designer',
  'testcase-review': 'test-designer',
  develop: 'developer',
  'feature-accept': 'tester',
  'e2e-accept': 'tester',
}

/** 正常顺序的下一阶段。 */
export const AGITEAM_NEXT_STAGE: Record<string, string | undefined> = {
  requirement: 'req-review',
  'req-review': 'product',
  product: 'product-review',
  'product-review': 'testcase',
  testcase: 'testcase-review',
  'testcase-review': 'develop',
  develop: 'feature-accept',
  'feature-accept': 'e2e-accept',
  'e2e-accept': 'done',
  done: undefined,
}

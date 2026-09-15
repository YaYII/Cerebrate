/**
 * 团队开发流程的文档数据模型 —— 各阶段产物的纯数据形状。
 *
 * 为什么独立成砖块：这些是跨阶段流转、落盘、渲染共享的契约，
 * 独立出来保证各业务模块对"需求长什么样/用例长什么样"只有一个事实源。
 *
 * 数据形状全部为可 JSON 序列化的纯数据（无函数/无 live 对象），
 * 便于落盘为 Markdown、传给 agent 上下文、渲染为对话消息。
 */

/** 单个需求条目（《需求清单》的一行）。 */
export interface RequirementItem {
  /** 需求编号（R-1, R-2 …）。 */
  id: string
  /** 需求标题。 */
  title: string
  /** 需求详述。 */
  detail: string
  /** 优先级（P0=核心必须 / P1=重要 / P2=可选）。 */
  priority: 'P0' | 'P1' | 'P2'
  /** 验收标准（可测试的描述）。 */
  acceptance: string
}

/** 需求清单文档。 */
export interface RequirementsDoc {
  /** 项目/需求名称。 */
  projectName: string
  /** 需求背景。 */
  background: string
  /** 需求条目列表。 */
  items: RequirementItem[]
}

/** 单个产品功能（《产品功能清单》的一行）。 */
export interface FeatureItem {
  /** 功能编号（F-1, F-2 …）。 */
  id: string
  /** 功能名称。 */
  name: string
  /** 关联需求编号（R-x）。 */
  requirementIds: string[]
  /** 功能详述（做什么）。 */
  description: string
  /** 用户操作路径（如何用）。 */
  userFlow: string
  /** 关联 API 端点（若有）。 */
  apiEndpoints?: string[]
}

/** 产品功能清单文档。 */
export interface FeaturesDoc {
  /** 项目名称。 */
  projectName: string
  /** 功能条目列表。 */
  items: FeatureItem[]
}

/** 单个测试用例（功能↔用例矩阵的一行）。 */
export interface TestCase {
  /** 用例编号（TC-1, TC-2 …）。 */
  id: string
  /** 关联功能编号（F-x）。 */
  featureId: string
  /** 用例标题。 */
  title: string
  /** 前置条件。 */
  preconditions: string
  /** 测试步骤。 */
  steps: string[]
  /** 期望结果。 */
  expected: string
  /** 用例类型：单测/API/UI/E2E。 */
  kind: 'unit' | 'api' | 'ui' | 'e2e'
}

/** 测试用例矩阵文档。 */
export interface TestcasesDoc {
  /** 项目名称。 */
  projectName: string
  /** 用例列表。 */
  cases: TestCase[]
  /** 每个功能对应的用例（功能 → 用例编号列表）。 */
  byFeature: Record<string, string[]>
}

/** 单个功能的验收结果。 */
export interface FeatureAcceptance {
  /** 功能编号。 */
  featureId: string
  /** 功能名。 */
  featureName: string
  /** 结论：通过/失败。 */
  passed: boolean
  /** 执行证据（命令/输出摘要）。 */
  evidence: string
  /** 失败原因（未通过时）。 */
  failureReason?: string
}

/** 验收报告文档。 */
export interface AcceptanceDoc {
  /** 项目名称。 */
  projectName: string
  /** 逐功能验收结果。 */
  features: FeatureAcceptance[]
  /** 端到端场景结果。 */
  e2eResults: Array<{
    /** 场景名。 */
    scenario: string
    /** 通过与否。 */
    passed: boolean
    /** 证据。 */
    evidence: string
  }>
  /** 总体结论。 */
  summary: string
}

/** 团队开发项目的完整状态（持久化于 artifactsDir 的 state.json）。 */
export interface TeamProjectState {
  /** 项目 id（目录名）。 */
  projectId: string
  /** 项目名。 */
  projectName: string
  /** 原始需求（用户输入）。 */
  rawRequirement: string
  /** 当前阶段。 */
  stage: string
  /** 各阶段完成标记（stage → true）。 */
  completed: Record<string, boolean>
  /** 评审意见（stage → 意见列表）。 */
  reviewComments: Record<string, string[]>
  /** 产物相对路径（stage → 文件路径）。 */
  artifacts: Record<string, string>
  /** 工作目录（绝对路径）。 */
  cwd: string
  /** 更新时间戳。 */
  updatedAt: number
}

// ── 追溯链实体（v2：需求→功能→用例→单测→代码→验收脚本→日志）──

/** 单元测试条目（开发产出，关联测试用例）。 */
export interface UnitTestItem {
  /** 单测编号（UT-1, UT-2 …）。 */
  id: string
  /** 关联测试用例编号（TC-x）。 */
  testCaseId: string
  /** 单测标题。 */
  title: string
  /** 单测文件相对路径。 */
  filePath: string
  /** 运行状态：通过/失败/未运行。 */
  status: 'passed' | 'failed' | 'pending'
  /** 最近运行时间戳。 */
  ranAt?: number
  /** 最近运行输出摘要。 */
  lastOutput?: string
}

/** 代码文件条目（开发产出，关联产品功能）。 */
export interface CodeFileItem {
  /** 文件编号（CF-1, CF-2 …）。 */
  id: string
  /** 关联产品功能编号（F-x）。 */
  featureId: string
  /** 文件相对路径。 */
  path: string
  /** 文件摘要（sha256 指纹，用于审计防篡改）。 */
  sha256: string
  /** 最后修改时间戳。 */
  updatedAt: number
  /** 文件行数。 */
  lines: number
}

/** 验收脚本条目（测试验收产出，关联产品功能，含真实运行日志）。 */
export interface AcceptanceScriptItem {
  /** 脚本编号（AS-1, AS-2 …）。 */
  id: string
  /** 关联产品功能编号（F-x）。 */
  featureId: string
  /** 脚本相对路径。 */
  path: string
  /** 脚本类型：api（模拟请求）/ ui（点击）/ script（自动化脚本）。 */
  kind: 'api' | 'ui' | 'script'
  /** 最近运行状态：通过/失败/未运行。 */
  status: 'passed' | 'failed' | 'pending'
  /** 运行日志文件相对路径（真实执行记录）。 */
  logFile?: string
  /** 最近运行时间戳。 */
  ranAt?: number
  /** 最近运行退出码。 */
  exitCode?: number | null
  /** 最近运行输出摘要。 */
  lastOutput?: string
}

/** 审计日志条目（每步操作，追加式 JSONL，带指纹防篡改）。 */
export interface AuditEntry {
  /** 序号（递增）。 */
  seq: number
  /** 时间戳（ms）。 */
  time: number
  /** 动作类型。 */
  action: string
  /** 执行角色（agent 名）。 */
  role: string
  /** 关联项目 id。 */
  projectId: string
  /** 关联阶段。 */
  stage: string
  /** 动作描述。 */
  detail: string
  /** 关联数据指纹（如产物 sha256），用于校验数据未被篡改。 */
  fingerprint?: string
  /** 校验结果快照（数学/脚本/日志三层校验摘要）。 */
  verify?: {
    mathPass: boolean
    scriptPass: boolean
    logPass: boolean
  }
  /** 前一条目的哈希（链式防篡改）。 */
  prevHash: string
  /** 本条目的哈希（sha256(seq|time|action|role|detail|fingerprint|prevHash)）。 */
  hash: string
}

/** 追溯矩阵行（面板核心视图：需求→功能→用例→单测→代码→验收脚本）。 */
export interface TraceRow {
  /** 需求编号。 */
  requirementId: string
  /** 需求标题。 */
  requirementTitle: string
  /** 功能编号。 */
  featureId: string
  /** 功能名。 */
  featureName: string
  /** 用例编号列表。 */
  testCaseIds: string[]
  /** 单测编号列表。 */
  unitTestIds: string[]
  /** 代码文件列表。 */
  codeFiles: string[]
  /** 验收脚本列表。 */
  acceptanceScripts: string[]
  /** 该行整体验收状态（全部通过才 ✅）。 */
  status: 'passed' | 'failed' | 'pending'
}

/** 项目完整追溯状态（面板快照数据源）。 */
export interface TraceState {
  /** 项目 id。 */
  projectId: string
  /** 项目名。 */
  projectName: string
  /** 当前阶段。 */
  stage: string
  /** 需求清单。 */
  requirements: RequirementItem[]
  /** 产品功能清单。 */
  features: FeatureItem[]
  /** 测试用例。 */
  testcases: TestCase[]
  /** 单元测试。 */
  unitTests: UnitTestItem[]
  /** 代码文件。 */
  codeFiles: CodeFileItem[]
  /** 验收脚本。 */
  acceptanceScripts: AcceptanceScriptItem[]
  /** 追溯矩阵。 */
  traceRows: TraceRow[]
  /** 审计日志（最近 N 条）。 */
  auditLog: AuditEntry[]
  /** 多层校验结果。 */
  verification: {
    mathPass: boolean
    scriptPass: boolean
    logPass: boolean
    details: string[]
  }
  /** 评审意见。 */
  reviewComments: Record<string, string[]>
  /** 更新时间。 */
  updatedAt: number
}

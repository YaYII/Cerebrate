/**
 * 团队角色定义与 agent 创建配方 —— 8 角色的职责、预设与创建参数。
 *
 * 为什么独立成模块：角色是"业务词汇"，按分层铁律放在业务层；
 * agent 创建配方（agents.create + setup mount preset）收口在这里，
 * 业务编排层只需调用 createRoleAgent()。
 */

/** 团队角色标识。 */
export type TeamRole =
  | 'supervisor'   // 主管：编排全流程
  | 'requirement'  // 需求分析师：产出《需求清单》
  | 'architect'    // 架构师：技术方案与架构约束
  | 'product'      // 产品经理：产出《产品功能清单》
  | 'req-reviewer' // 需求评审员：评审《需求清单》
  | 'prod-reviewer' // 产品评审员：评审《产品功能清单》
  | 'test-designer' // 测试设计师：产出《测试用例矩阵》
  | 'developer'    // 开发工程师：实现功能点 + 单元测试
  | 'tester'       // 测试验收员：逐功能验收 + E2E

/** 角色中文名。 */
export const ROLE_NAMES: Record<TeamRole, string> = {
  supervisor: '主管',
  requirement: '需求分析师',
  architect: '架构师',
  product: '产品经理',
  'req-reviewer': '需求评审员',
  'prod-reviewer': '产品评审员',
  'test-designer': '测试设计师',
  developer: '开发工程师',
  tester: '测试验收员',
}

/** 角色职责说明（用于 preset persona 与引导消息）。 */
export const ROLE_DUTIES: Record<TeamRole, string> = {
  supervisor: '你是团队主管，负责编排整个开发流程：启动项目、分派任务给各角色、汇总产物、控制阶段流转与门禁。',
  requirement: '你是需求分析师，负责把原始需求拆解为结构化《需求清单》（编号/标题/详述/优先级/验收标准）。',
  architect: '你是架构师，负责评估技术方案、识别架构约束与风险，为开发提供技术指引。',
  product: '你是产品经理，负责把需求清单转化为《产品功能清单》（功能编号/名称/关联需求/用户路径/API 端点）。',
  'req-reviewer': '你是需求评审员，独立评审《需求清单》是否完整、清晰、可验收；不通过时给出具体打回意见。',
  'prod-reviewer': '你是产品评审员，独立评审《产品功能清单》是否覆盖需求、路径清晰、无遗漏；不通过时给出具体意见。',
  'test-designer': '你是测试设计师，负责为每个功能点设计测试用例（单测/API/UI/E2E），产出《测试用例矩阵》。',
  developer: '你是开发工程师，按功能清单与测试用例实现每个功能点，并为每个功能点编写单元测试。',
  tester: '你是测试验收员，执行逐功能验收（单测 + API 模拟请求 + 自动化脚本）与端到端用户场景验收，输出《验收报告》。',
}

/** 角色 → 对应 agent preset id。 */
export const ROLE_PRESET: Record<TeamRole, string> = {
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

/** 各阶段 → 主要负责角色（用于编排时决定创建/唤醒哪个角色 agent）。 */
export const STAGE_ROLE: Record<string, TeamRole> = {
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

/** 评审阶段 → 评审角色（用于门禁打回）。 */
export const REVIEW_ROLE: Partial<Record<string, TeamRole>> = {
  'req-review': 'req-reviewer',
  'product-review': 'prod-reviewer',
  'testcase-review': 'test-designer',
}

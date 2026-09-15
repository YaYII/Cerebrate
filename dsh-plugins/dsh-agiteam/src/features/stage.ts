/**
 * 阶段状态机 —— 团队开发流程的九阶段定义与流转规则。
 *
 * 为什么独立成砖块：阶段流转是纯数据变换（无 IO、无 agent），
 * 独立出来可单测、可被业务层任意组合。
 *
 * 九阶段全流程（对应传统软件团队流程）：
 *   requirement      → 需求分析（产出《需求清单》）
 *   req-review       → 需求评审（门禁：通过才放行）
 *   product          → 产品设计（产出《产品功能清单》）
 *   product-review   → 产品评审（门禁：通过才放行）
 *   testcase         → 测试用例设计（产出功能↔用例矩阵）
 *   testcase-review  → 测试用例评审（门禁：通过才放行）
 *   develop          → 正式开发（每个功能点实现 + 单元测试）
 *   feature-accept   → 逐功能验收（单测 + API 模拟请求 + 自动化脚本）
 *   e2e-accept       → 模拟用户场景端到端验收
 *   done             → 交付
 *
 * 评审不过 = 打回上一阶段（带评审意见），而非死锁。
 */

/** 全部阶段标识。 */
export type StageId =
  | 'requirement'
  | 'req-review'
  | 'product'
  | 'product-review'
  | 'testcase'
  | 'testcase-review'
  | 'develop'
  | 'feature-accept'
  | 'e2e-accept'
  | 'done'

/** 阶段中文名（用于文档/消息）。 */
export const STAGE_NAMES: Record<StageId, string> = {
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

/** 阶段序号（用于排序/进度展示）。 */
export const STAGE_ORDER: Record<StageId, number> = {
  requirement: 0,
  'req-review': 1,
  product: 2,
  'product-review': 3,
  testcase: 4,
  'testcase-review': 5,
  develop: 6,
  'feature-accept': 7,
  'e2e-accept': 8,
  done: 9,
}

/** 正常顺序的下一阶段（不含 done）。 */
const NEXT: Record<StageId, StageId | undefined> = {
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

/** 评审阶段 → 被打回时回到的上一阶段。 */
const REVIEW_BACK: Partial<Record<StageId, StageId>> = {
  'req-review': 'requirement',
  'product-review': 'product',
  'testcase-review': 'testcase',
}

/** 是否评审阶段。 */
export function isReviewStage(stage: StageId): boolean {
  return stage === 'req-review' || stage === 'product-review' || stage === 'testcase-review'
}

/** 下一阶段；done 无后继返回 undefined。 */
export function nextStage(stage: StageId): StageId | undefined {
  return NEXT[stage]
}

/** 评审打回目标；非评审阶段返回 undefined。 */
export function reviewBackTo(stage: StageId): StageId | undefined {
  return REVIEW_BACK[stage]
}

/** 阶段序号差（用于进度百分比）。 */
export function progressOf(stage: StageId): number {
  return STAGE_ORDER[stage] / STAGE_ORDER.done
}

/** 阶段是否为流水线阶段（requirement/product/testcase/develop/feature-accept/e2e-accept）。 */
export function isWorkStage(stage: StageId): boolean {
  return !isReviewStage(stage) && stage !== 'done'
}

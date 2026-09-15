/**
 * 追溯矩阵 —— 把需求/功能/用例/单测/代码/验收脚本组装为一行式追溯视图。
 *
 * 为什么独立成砖块：矩阵组装是纯数据变换（无 IO/agent），
 * 独立出来可单测、可被面板与工具复用。
 */

import type {
  AcceptanceScriptItem,
  CodeFileItem,
  FeatureItem,
  RequirementItem,
  TestCase,
  TraceRow,
  UnitTestItem,
} from './model'

/**
 * 组装追溯矩阵：每个功能一行，聚合其需求、用例、单测、代码、验收脚本。
 * @returns 按功能编号排序的追溯行。
 */
export function buildTraceRows(
  requirements: RequirementItem[],
  features: FeatureItem[],
  testcases: TestCase[],
  unitTests: UnitTestItem[],
  codeFiles: CodeFileItem[],
  scripts: AcceptanceScriptItem[],
): TraceRow[] {
  const reqById = new Map(requirements.map(r => [r.id, r]))
  const rows: TraceRow[] = []

  for (const feature of features) {
    // 功能 → 需求（可能多个）
    const reqIds = feature.requirementIds.length > 0 ? feature.requirementIds : ['-']
    // 功能 → 用例
    const featureCases = testcases.filter(t => t.featureId === feature.id)
    const caseIds = featureCases.map(t => t.id)
    // 用例 → 单测
    const featureUnitTests = unitTests.filter(u => featureCases.some(tc => tc.id === u.testCaseId))
    const unitTestIds = featureUnitTests.map(u => u.id)
    // 功能 → 代码
    const featureCodeFiles = codeFiles.filter(cf => cf.featureId === feature.id)
    // 功能 → 验收脚本
    const featureScripts = scripts.filter(s => s.featureId === feature.id)

    // 状态判定：脚本全过 && 单测全过 && 有用例 → passed
    let status: TraceRow['status'] = 'pending'
    if (featureCases.length > 0 && featureUnitTests.length > 0 && featureScripts.length > 0) {
      const allPassed = featureScripts.every(s => s.status === 'passed')
        && featureUnitTests.every(u => u.status === 'passed')
      status = allPassed ? 'passed' : 'failed'
    }

    for (const reqId of reqIds) {
      const req = reqById.get(reqId)
      rows.push({
        requirementId: reqId,
        requirementTitle: req?.title ?? '（未关联需求）',
        featureId: feature.id,
        featureName: feature.name,
        testCaseIds: caseIds,
        unitTestIds,
        codeFiles: featureCodeFiles.map(cf => cf.path),
        acceptanceScripts: featureScripts.map(s => s.path),
        status,
      })
    }
  }

  // 按功能编号排序（F-1 < F-2 …）
  return rows.sort((a, b) => a.featureId.localeCompare(b.featureId, undefined, { numeric: true }))
}

/** 追溯矩阵是否全部通过。 */
export function traceAllPassed(rows: TraceRow[]): boolean {
  return rows.length > 0 && rows.every(r => r.status === 'passed')
}

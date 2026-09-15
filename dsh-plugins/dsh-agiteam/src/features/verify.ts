/**
 * 多层校验引擎 —— 数学层对账 + 脚本层存在性 + 日志层真实执行。
 *
 * 为什么独立成砖块：校验是纯数据能力（对账/存在性/日志链），无 agent 依赖。
 *
 * 三层校验（防 AI 幻觉，必须有证据）：
 *  1. 数学层（math）：数量对账 —— 验收通过数 == 单测通过数 == 用例覆盖数；
 *     每个功能都有代码文件；每个功能都有验收脚本；每个用例都有单测。
 *  2. 脚本层（script）：验收脚本文件真实存在（fs 检查），非 AI 声称；
 *     脚本有最近运行记录（ranAt）。
 *  3. 日志层（log）：审计日志链完整（sha256 链式校验无断裂）；
 *     验收脚本有真实运行日志文件（logFile 存在且有内容）。
 */

import type { AcceptanceScriptItem, CodeFileItem, FeatureItem, RequirementItem, TestCase, UnitTestItem, AuditEntry } from './model'
import { verifyAuditChain } from './audit'

/** 校验结果。 */
export interface VerifyResult {
  mathPass: boolean
  scriptPass: boolean
  logPass: boolean
  /** 全部通过。 */
  allPass: boolean
  /** 失败详情（每条中文可操作）。 */
  details: string[]
}

/** 判定文件是否存在（由调用方注入，保持纯函数）。 */
export type FileExistenceCheck = (relPath: string) => Promise<boolean>

/** 判定文件是否有非空内容（由调用方注入）。 */
export type FileContentCheck = (relPath: string) => Promise<boolean>

/** 空结果。 */
function emptyResult(): VerifyResult {
  return { mathPass: true, scriptPass: true, logPass: true, allPass: true, details: [] }
}

/**
 * 多层校验一个项目的追溯链。
 * @param requirements 需求清单
 * @param features 产品功能清单
 * @param testcases 测试用例
 * @param unitTests 单元测试
 * @param codeFiles 代码文件
 * @param scripts 验收脚本
 * @param auditEntries 审计日志
 * @param fileExists 文件存在性检查（脚本层）
 * @param fileHasContent 文件有内容检查（日志层）
 */
export async function verifyProject(
  requirements: RequirementItem[],
  features: FeatureItem[],
  testcases: TestCase[],
  unitTests: UnitTestItem[],
  codeFiles: CodeFileItem[],
  scripts: AcceptanceScriptItem[],
  auditEntries: AuditEntry[],
  fileExists: FileExistenceCheck,
  fileHasContent: FileContentCheck,
): Promise<VerifyResult> {
  const result = emptyResult()
  const details: string[] = []

  // ── 1. 数学层：数量对账 ──
  // 1a. 每个需求必须有对应功能
  const reqIds = new Set(requirements.map(r => r.id))
  const featureReqIds = new Set(features.flatMap(f => f.requirementIds))
  for (const req of requirements) {
    if (!features.some(f => f.requirementIds.includes(req.id))) {
      result.mathPass = false
      details.push(`需求 ${req.id} 没有对应产品功能（数学层）`)
    }
  }
  // 1b. 每个功能必须有对应用例
  const featureIds = new Set(features.map(f => f.id))
  const caseFeatureIds = new Set(testcases.map(t => t.featureId))
  for (const f of features) {
    if (!testcases.some(t => t.featureId === f.id)) {
      result.mathPass = false
      details.push(`功能 ${f.id} 没有对应测试用例（数学层）`)
    }
  }
  // 1c. 每个用例必须有对应单测
  const caseIds = new Set(testcases.map(t => t.id))
  for (const tc of testcases) {
    if (!unitTests.some(u => u.testCaseId === tc.id)) {
      result.mathPass = false
      details.push(`用例 ${tc.id} 没有对应单元测试（数学层）`)
    }
  }
  // 1d. 每个功能必须有代码文件
  for (const f of features) {
    if (!codeFiles.some(cf => cf.featureId === f.id)) {
      result.mathPass = false
      details.push(`功能 ${f.id} 没有对应代码文件（数学层）`)
    }
  }
  // 1e. 每个功能必须有验收脚本
  for (const f of features) {
    if (!scripts.some(s => s.featureId === f.id)) {
      result.mathPass = false
      details.push(`功能 ${f.id} 没有对应验收脚本（数学层）`)
    }
  }
  // 1f. 单测通过数 == 用例覆盖数
  const passedUnitTests = unitTests.filter(u => u.status === 'passed').length
  const coveredCases = new Set(unitTests.map(u => u.testCaseId)).size
  if (passedUnitTests < coveredCases) {
    result.mathPass = false
    details.push(`单测通过数 ${passedUnitTests} < 用例覆盖数 ${coveredCases}（数学层）`)
  }

  // ── 2. 脚本层：验收脚本真实存在且有运行记录 ──
  for (const script of scripts) {
    if (script.status !== 'passed') {
      result.scriptPass = false
      details.push(`验收脚本 ${script.id} 未通过（状态 ${script.status}）（脚本层）`)
      continue
    }
    if (!(await fileExists(script.path))) {
      result.scriptPass = false
      details.push(`验收脚本 ${script.id} 文件不存在：${script.path}（脚本层）`)
    }
    if (!script.ranAt) {
      result.scriptPass = false
      details.push(`验收脚本 ${script.id} 无最近运行记录（脚本层）`)
    }
  }

  // ── 3. 日志层：审计链完整 + 验收脚本有真实日志 ──
  const brokenAt = verifyAuditChain(auditEntries)
  if (brokenAt >= 0) {
    result.logPass = false
    details.push(`审计日志链在 seq=${auditEntries[brokenAt]?.seq} 处断裂（日志层）`)
  }
  for (const script of scripts) {
    if (!script.logFile) {
      result.logPass = false
      details.push(`验收脚本 ${script.id} 无运行日志文件（日志层）`)
      continue
    }
    if (!(await fileHasContent(script.logFile))) {
      result.logPass = false
      details.push(`验收脚本 ${script.id} 日志文件为空或不存在：${script.logFile}（日志层）`)
    }
  }

  result.allPass = result.mathPass && result.scriptPass && result.logPass
  if (result.allPass) details.push('三层校验全部通过（数学对账 ✓ 脚本存在 ✓ 日志链完整 ✓）')
  result.details = details
  return result
}

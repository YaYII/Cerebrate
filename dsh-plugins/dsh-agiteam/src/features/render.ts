/**
 * 阶段产物文档渲染 —— 把数据模型渲染为落盘与对话可见的 Markdown。
 *
 * 为什么独立成砖块：渲染是纯函数（数据 → 文本），无 IO、无 agent，
 * 独立出来可单测，且业务层只需传数据即可获得一致的文档形态。
 */

import type { AcceptanceDoc, FeaturesDoc, RequirementsDoc, TestcasesDoc } from './model'

/** 把《需求清单》渲染为 Markdown。 */
export function renderRequirements(doc: RequirementsDoc): string {
  const lines = [
    `# 需求清单：${doc.projectName}`,
    '',
    '## 需求背景',
    '',
    doc.background,
    '',
    '## 需求条目',
    '',
    '| 编号 | 标题 | 优先级 | 验收标准 |',
    '| --- | --- | --- | --- |',
  ]
  for (const item of doc.items) {
    lines.push(`| ${item.id} | ${item.title} | ${item.priority} | ${item.acceptance} |`)
  }
  lines.push('', '## 需求详情', '')
  for (const item of doc.items) {
    lines.push(`### ${item.id} ${item.title}`, '', item.detail, '')
  }
  return lines.join('\n')
}

/** 把《产品功能清单》渲染为 Markdown。 */
export function renderFeatures(doc: FeaturesDoc): string {
  const lines = [
    `# 产品功能清单：${doc.projectName}`,
    '',
    '| 编号 | 功能名 | 关联需求 | 说明 | 用户路径 | API 端点 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of doc.items) {
    const reqs = item.requirementIds.join(', ')
    const apis = (item.apiEndpoints ?? []).join(', ') || '-'
    lines.push(`| ${item.id} | ${item.name} | ${reqs} | ${item.description} | ${item.userFlow} | ${apis} |`)
  }
  return lines.join('\n')
}

/** 把《测试用例矩阵》渲染为 Markdown。 */
export function renderTestcases(doc: TestcasesDoc): string {
  const lines = [
    `# 测试用例矩阵：${doc.projectName}`,
    '',
    '| 用例 | 关联功能 | 类型 | 标题 | 前置 | 期望结果 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const c of doc.cases) {
    lines.push(`| ${c.id} | ${c.featureId} | ${c.kind} | ${c.title} | ${c.preconditions} | ${c.expected} |`)
  }
  lines.push('', '## 测试步骤', '')
  for (const c of doc.cases) {
    lines.push(`### ${c.id} ${c.title}`, '', `**前置**：${c.preconditions}`, '', '**步骤**：')
    for (const [i, s] of c.steps.entries()) lines.push(`${i + 1}. ${s}`)
    lines.push('', `**期望**：${c.expected}`, '')
  }
  return lines.join('\n')
}

/** 把《验收报告》渲染为 Markdown。 */
export function renderAcceptance(doc: AcceptanceDoc): string {
  const lines = [
    `# 验收报告：${doc.projectName}`,
    '',
    '## 逐功能验收',
    '',
    '| 功能 | 结论 | 证据 |',
    '| --- | --- | --- |',
  ]
  for (const f of doc.features) {
    lines.push(`| ${f.featureId} ${f.featureName} | ${f.passed ? '✅ 通过' : '❌ 失败'} | ${f.evidence} |`)
  }
  lines.push('', '## 端到端场景', '', '| 场景 | 结论 | 证据 |', '| --- | --- | --- |')
  for (const e of doc.e2eResults) {
    lines.push(`| ${e.scenario} | ${e.passed ? '✅ 通过' : '❌ 失败'} | ${e.evidence} |`)
  }
  lines.push('', '## 总结', '', doc.summary)
  return lines.join('\n')
}

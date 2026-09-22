/**
 * 真实链路验证 —— 用真实语料把「同一个语义问题」的两种解法摆在一起对比。
 *
 * 本文件干什么：用 dsh-meridian 的真实运行语料（真实流量日志行）跑一次真实判定，
 *   证明本插件在**文案漂移**下仍然给出正确判定，而硬编码子串匹配会静默失效。
 * 本文件不干什么：不进 CI、不影响构建（需真实网络与密钥，属显式运行的验证脚本）。
 *
 * 为什么要它（CODE_STANDARDS 式证据文化）：任何「本插件有用」的结论都必须能被复现，
 * 而不是靠单元测试里编造的回包自证。本脚本是端到端证据。
 *
 * 用法：
 *   node --import tsx scripts/verify-live.ts
 * 密钥：TYPESAFE_API_KEY，或 ~/.credentials/typesafe-api-key。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

import { resolveApiKey, TypeSafeClient } from '../src/features/client'
import type { QuestionSpec } from '../src/features/primitives'

/** 一个验证场景：一段运行日志 + 人工确认的标准答案。 */
interface Scenario {
  name: string
  /** 标准答案：哪个事件体现了「主档落库」；null 表示本案例不应判定为写流程。 */
  expectEvent: string | null
  /** 确定性匹配器（现行 labelContains 子串语义）会怎么判。 */
  deterministicHit: boolean
  events: { id: string; content: string }[]
}

/** 真实语料来自 dsh-meridian 的 tests/liveTraffic.spec.ts（真实流量行，非编造）。 */
const SCENARIOS: Scenario[] = [
  {
    name: '写流程成功（真实语料）',
    expectEvent: 'e2',
    deterministicHit: true,
    events: [
      { id: 'e1', content: '核验完成: orderNo=ORD-E2E-001, refId=E2E-1789454477943-8cf3dd, verified=true, bindResult=SUCCESS, 核验耗时=58ms, 状态持有耗时=60ms' },
      { id: 'e2', content: '主档收敛为 SUCCESS(定向UPDATE): orderNo=ORD-E2E-001' },
    ],
  },
  {
    name: '读流程命中缓存（真实语料，本就不写主档）',
    expectEvent: null,
    deterministicHit: true,
    events: [
      { id: 'e1', content: '核验结果命中缓存: refId=ORD-E2E-001, verified=true' },
      { id: 'e2', content: '查询返回: orderNo=ORD-E2E-001 状态=已核验' },
    ],
  },
  {
    name: '写流程成功（全英文改写：语义不变、文案全变）',
    expectEvent: 'e2',
    deterministicHit: false,
    events: [
      { id: 'e1', content: 'verification passed: orderNo=ORD-E2E-001, bindResult=SUCCESS, cost=58ms' },
      { id: 'e2', content: 'master record converged to SUCCESS: orderNo=ORD-E2E-001' },
    ],
  },
]

/** 构造这个语义问题对应的判定问题（与 Meridian 的 appliesWhen + 步骤匹配等价）。 */
function buildQuestions(scenario: Scenario): Record<string, QuestionSpec> {
  return {
    is_confirm_write_flow: {
      type: 'noul',
      instructions:
        'This session is a full verification WRITE flow in which the master record is expected to be written. It is NOT a read-only cache hit, NOT an idempotent short-circuit returning an already-verified result, and NOT a rejection branch. Judge by meaning, not by exact wording.',
    },
    main_record_step: {
      type: 'choice',
      instructions:
        "Which single event in the session is the master record write/convergence step? Judge by meaning, not by exact wording. If no event fulfils it, choose none.",
      criteria: Object.fromEntries([
        ...scenario.events.map((event) => [event.id, event.content]),
        ['none', 'No event in this session fulfils the master record write step'],
      ]),
    },
  }
}

/** 主流程：逐场景真实调用，逐场景给出对比结论。 */
async function main(): Promise<void> {
  const apiKey = resolveApiKey({})
  const client = new TypeSafeClient({ apiKey })
  console.log('真实链路验证：同一语义问题，两种解法的对照')
  console.log('='.repeat(96))
  let semanticCorrect = 0

  for (const scenario of SCENARIOS) {
    const result = await client.judge({ state: { runtime_case: { case_id: scenario.name, events: scenario.events } }, questions: buildQuestions(scenario) })
    const gate = result.answers.is_confirm_write_flow
    const pick = result.answers.main_record_step
    const inScope = gate?.type === 'noul' && gate.noul >= 0.5
    const picked = pick?.type === 'choice' && pick.choice !== 'none' ? pick.choice : null
    const correct = scenario.expectEvent === null ? !inScope : inScope && picked === scenario.expectEvent
    if (correct) semanticCorrect += 1

    console.log('')
    console.log('【' + scenario.name + '】')
    console.log('  标准答案：' + (scenario.expectEvent === null ? '非写流程（应跳过）' : '写流程，主档步骤=' + scenario.expectEvent))
    console.log('  确定性匹配器（labelContains 子串）：' + (scenario.deterministicHit ? '命中' : '未命中 → 判 out-of-scope（静默跳过真实偏离）'))
    console.log('  本插件（Jev 判定）：' + (inScope ? 'in-scope' : 'out-of-scope') + '，choice=' + String(picked) + '  → ' + (correct ? '✅ 与标准答案一致' : '❌ 与标准答案不一致'))
    console.log('  用量：' + (result.usage === null ? '未知' : 'in=' + result.usage.inputTokens + ' out=' + result.usage.outputTokens) + '｜模型=' + result.model)
  }

  console.log('')
  console.log('='.repeat(96))
  console.log('本插件判定正确：' + semanticCorrect + '/' + SCENARIOS.length)
  const deterministicCorrect = SCENARIOS.filter((item) => item.deterministicHit === (item.expectEvent !== null)).length
  console.log('确定性子串匹配正确：' + deterministicCorrect + '/' + SCENARIOS.length)
  if (semanticCorrect !== SCENARIOS.length) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error('验证失败：' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})

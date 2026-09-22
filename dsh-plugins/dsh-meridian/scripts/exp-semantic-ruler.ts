#!/usr/bin/env node
/**
 * 实验：标尺的「意图匹配」是硬编码子串，语义改写即静默失效。
 *
 * 本文件干什么：用**真实语料**（DSEDT 生产日志原文，取自 tests/liveTraffic.spec.ts）构造
 *   5 个场景，对比两种匹配器在同一批场景上的判定正确率：
 *   - 确定性匹配器：复刻 src/features/ruler.ts 的 `labelContains` 子串语义（当前实现）；
 *   - 语义匹配器：把同一意图交给 TypeSafe System One（Jev）做结构化判定。
 * 本文件不干什么：不改动 ruler.ts 的任何行为，不写回任何业务数据，只出对比证据。
 *
 * 为什么需要它（CODE_STANDARDS §7 证据文化）：任何「现有实现有缺陷」的结论必须附可复现实验。
 * 本脚本就是「子串匹配对文案脆弱」这条结论的反证测试——语料全部来自真实运行产物，非想象数据。
 *
 * 用法：
 *   node --import tsx scripts/exp-semantic-ruler.ts
 * 密钥：单一来源 ~/.credentials/typesafe-api-key，或环境变量 TYPESAFE_API_KEY；两者皆无则退出（不写入任何文件）。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 运行时事件（本实验只关心 id / 相位 / 文案三件事，故取 ruler 模型的最小投影）。 */
interface ExpEvent {
  id: string
  phase: string
  content: string
}

/** 一个实验场景：一段真实（或按真实语义改写）的运行日志，外加该案例的标准答案。 */
interface Scenario {
  name: string
  /** 是否**本当**判定为「核验写流程」（标准答案，来自人工业务确认）。 */
  truthInScope: boolean
  /** 若在适用范围内，期望命中「主档落库」步骤的事件 id；不在范围内则为 null。 */
  truthMainRecordEvent: string | null
  events: ExpEvent[]
  /** 文案改写说明（真实语料为「未改写」）。 */
  rephraseNote: string
}

/** 两种匹配器在一个场景上的判定结果。 */
interface Judgement {
  inScope: boolean
  mainRecordEvent: string | null
  detail: string
}

/** 真实语料：核验写流程的完成行（tests/liveTraffic.spec.ts L_CONFIRM_DONE）。 */
const L_CONFIRM_DONE = '核验完成: orderNo=ORD-E2E-001, refId=E2E-1789454477943-8cf3dd, verified=true, bindResult=SUCCESS, 核验耗时=58ms, 状态持有耗时=60ms'

/** 真实语料：主档收敛（tests/liveTraffic.spec.ts L_CONVERGE）。 */
const L_CONVERGE = '主档收敛为 SUCCESS(定向UPDATE): orderNo=ORD-E2E-001'

/** 真实语料：商户查询读流程命中结果缓存（tests/liveTraffic.spec.ts L_CACHE_QUERY）。 */
const L_CACHE_QUERY = '核验结果命中缓存: refId=ORD-E2E-001, verified=true'

/** 真实语料：幂等重复核验被结果缓存短路（tests/liveTraffic.spec.ts L_CACHE_IDEMPOTENT）。 */
const L_CACHE_IDEMPOTENT = '核验命中结果缓存: verified=true'

/** 真实语料：环境中 redis 降级噪音。 */
const L_REDIS_NOISE = '异步落库入队失败: redis 连接为空'

/**
 * 构造 5 个场景。
 *
 * 后三个场景是**同一个业务事实**（核验写流程成功 → 主档收敛）的三档文案演变：
 * 未改写 → 轻度改写（中英混排）→ 重度改写（全英文）。业务语义完全不变，
 * 变的只有日志文案——这正是真实重构/加日志时会发生的漂移。
 */
function buildScenarios(): Scenario[] {
  return [
    {
      name: '写流程成功（真实语料）',
      truthInScope: true,
      truthMainRecordEvent: 'e2',
      rephraseNote: '未改写',
      events: [
        { id: 'e1', phase: 'step', content: L_CONFIRM_DONE },
        { id: 'e2', phase: 'step', content: L_CONVERGE },
        { id: 'e3', phase: 'step', content: L_REDIS_NOISE },
      ],
    },
    {
      name: '读流程命中缓存（真实语料）',
      truthInScope: false,
      truthMainRecordEvent: null,
      rephraseNote: '未改写',
      events: [
        { id: 'e1', phase: 'step', content: L_CACHE_QUERY },
        { id: 'e2', phase: 'step', content: '查询返回: orderNo=ORD-E2E-001 状态=已核验' },
      ],
    },
    {
      name: '幂等缓存短路（真实语料）',
      truthInScope: false,
      truthMainRecordEvent: null,
      rephraseNote: '未改写',
      events: [
        { id: 'e1', phase: 'step', content: L_CACHE_IDEMPOTENT },
        { id: 'e2', phase: 'step', content: '返回已核验结果: verified=true' },
      ],
    },
    {
      name: '写流程成功（轻度改写）',
      truthInScope: true,
      truthMainRecordEvent: 'e2',
      rephraseNote: '「核验完成:」→「confirm 完成 - 」；「主档收敛」→「主档 converge」',
      events: [
        { id: 'e1', phase: 'step', content: 'confirm 完成 - orderNo=ORD-E2E-001, verified=true, bindResult=SUCCESS' },
        { id: 'e2', phase: 'step', content: '主档 converge 为 SUCCESS: orderNo=ORD-E2E-001' },
      ],
    },
    {
      name: '写流程成功（重度改写）',
      truthInScope: true,
      truthMainRecordEvent: 'e2',
      rephraseNote: '全英文重写：「verification passed」「master record converged」',
      events: [
        { id: 'e1', phase: 'step', content: 'verification passed: orderNo=ORD-E2E-001, bindResult=SUCCESS, cost=58ms' },
        { id: 'e2', phase: 'step', content: 'master record converged to SUCCESS: orderNo=ORD-E2E-001' },
        { id: 'e3', phase: 'step', content: 'archive enqueue failed: redis unavailable' },
      ],
    },
  ]
}

/**
 * 确定性匹配器：复刻 ruler.ts 当前的 `labelContains` 子串语义。
 *
 * 与真实实现的等价性：ruler 的 `matches()` 对 `labelContains` 就是
 * `label.toLowerCase().includes(x.toLowerCase())`，故此处子串判定与线上等价。
 */
function judgeDeterministic(scenario: Scenario): Judgement {
  const appliesWhen = '核验完成:'
  const inScope = scenario.events.some((e) => e.content.toLowerCase().includes(appliesWhen.toLowerCase()))
  if (!inScope) return { inScope: false, mainRecordEvent: null, detail: 'appliesWhen 未命中 → out-of-scope' }
  const hit = scenario.events.find((e) => e.content.includes('主档')) ?? null
  return {
    inScope: true,
    mainRecordEvent: hit?.id ?? null,
    detail: hit ? `appliesWhen 命中；主档步骤命中 ${hit.id}` : 'appliesWhen 命中，但「主档」子串无命中 → 会报「漏做环节」',
  }
}

/** 读取 TypeSafe 密钥：环境变量优先，其次 ~/.credentials/typesafe-api-key（单一来源，600）。 */
function readApiKey(): string {
  const fromEnv = process.env.TYPESAFE_API_KEY
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const text = readFileSync(join(homedir(), '.credentials', 'typesafe-api-key'), 'utf8').trim()
    if (text !== '') return text
  } catch {
    /* 回落到下面的显式失败 */
  }
  throw new Error('缺少 TypeSafe 密钥：请设置 TYPESAFE_API_KEY，或写入 ~/.credentials/typesafe-api-key')
}

/**
 * 语义匹配器：把同一个意图交给 Jev 做两次结构化判定。
 *
 * - q1（Noul）判断该案例是否属于「核验写流程」——替代 ruler 的 appliesWhen 门槛；
 * - q2（Choice）在候选事件中选出「主档落库」步骤——替代 ruler 的 labelContains 步骤匹配。
 * 候选即事件 id，模型无法选出未提供的选项（candidate coverage）。
 */
async function judgeSemantic(scenario: Scenario, apiKey: string): Promise<Judgement> {
  const body = {
    state: { runtime_case: { case_id: scenario.name, events: scenario.events } },
    model: 'jev-latest',
    questions: {
      is_confirm_write_flow: {
        type: 'noul',
        instructions:
          'This session is a full verification WRITE flow in which the master record (主档) is expected to be written. It is NOT a read-only cache hit, NOT an idempotent short-circuit returning an already-verified result, and NOT a rejection branch. Judge by meaning, not by exact wording.',
      },
      main_record_step: {
        type: 'choice',
        instructions:
          "Which single event in `runtime_case.events` is the master record (主档) write/convergence step that fulfils the expected step named '主档落库(收敛或INSERT兜底)'? Judge by meaning, not by exact wording. If no event fulfils it, choose none.",
        criteria: Object.fromEntries([
          ...scenario.events.map((e) => [e.id, e.content]),
          ['none', 'No event in this session fulfils the master record write step'],
        ]),
      },
    },
  }

  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`TypeSafe 返回 HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const payload = (await response.json()) as {
    answers: { is_confirm_write_flow: { noul: number }; main_record_step: { choice: string; confidence: number } }
  }
  const gate = payload.answers.is_confirm_write_flow.noul
  const pick = payload.answers.main_record_step.choice
  const confidence = payload.answers.main_record_step.confidence
  const inScope = gate >= 0.5
  return {
    inScope,
    mainRecordEvent: inScope && pick !== 'none' ? pick : null,
    detail: `noul=${gate.toFixed(2)}（阈值 0.5）→ ${inScope ? 'in-scope' : 'out-of-scope'}；choice=${pick}（confidence=${confidence.toFixed(2)}）`,
  }
}

/** 判定一个结果是否与标准答案一致。 */
function isCorrect(scenario: Scenario, judgement: Judgement): boolean {
  if (scenario.truthInScope !== judgement.inScope) return false
  if (!scenario.truthInScope) return true
  return scenario.truthMainRecordEvent === judgement.mainRecordEvent
}

/** 主流程：跑完 5 个场景 × 2 个匹配器，打印逐场景判定与总分。 */
async function main(): Promise<void> {
  const apiKey = readApiKey()
  const scenarios = buildScenarios()
  let deterministicScore = 0
  let semanticScore = 0

  console.log('场景对照（真实语料 + 同义改写）')
  console.log('='.repeat(100))

  for (const scenario of scenarios) {
    const deterministic = judgeDeterministic(scenario)
    const semantic = await judgeSemantic(scenario, apiKey)
    const dOk = isCorrect(scenario, deterministic)
    const sOk = isCorrect(scenario, semantic)
    if (dOk) deterministicScore += 1
    if (sOk) semanticScore += 1

    console.log(`
【${scenario.name}】标准答案：${scenario.truthInScope ? `写流程，主档步骤=${scenario.truthMainRecordEvent}` : '非写流程（应跳过）'}`)
    console.log(`  文案：${scenario.rephraseNote}`)
    console.log(`  确定性匹配器 ${dOk ? '✅' : '❌'}  ${deterministic.detail}`)
    console.log(`  语义匹配器   ${sOk ? '✅' : '❌'}  ${semantic.detail}`)
  }

  console.log('\n' + '='.repeat(100))
  console.log(`确定性匹配器（现行 labelContains 子串）：${deterministicScore}/${scenarios.length}`)
  console.log(`语义匹配器（TypeSafe Jev 结构化判定）：     ${semanticScore}/${scenarios.length}`)
}

main().catch((error: unknown) => {
  console.error(`实验失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

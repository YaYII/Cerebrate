#!/usr/bin/env node
/**
 * 插件冒烟测试 —— 加载构建产物，模拟 DSH 注册上下文，用真实日志调用四个工具。
 *
 * 本文件干什么：验证「插件能被装配、工具能被注册、execute 能返回真实结果」这条链路。
 * 本文件不干什么：不启动 DSH、不改被观测项目。
 *
 * 用法：node scripts/dev-smoke.mjs
 *
 * @module @deepseek-ai/dsh-meridian
 */

import { apply } from '../lib/index.js'

/** 模拟注册上下文，收集注册进来的工具与事件监听。 */
const registered = []
const listeners = []
const ctx = {
  tools: { register: (tool) => registered.push(tool) },
  on: (event, handler) => listeners.push({ event, handler }),
}

apply(ctx, { defaultPack: 'dsedt', injectGuidance: true })

console.log(`✅ 插件装配成功，注册工具 ${registered.length} 个：`)
for (const tool of registered) console.log(`   · ${tool.name ?? '(无 name)'}`)
console.log(`✅ 事件监听 ${listeners.length} 个：${listeners.map((item) => item.event).join(', ')}`)
if (!listeners.some((item) => item.event === 'agent/pre-step')) {
  throw new Error('未注册 agent/pre-step 监听：使用指引不会注入')
}

const DSEDT_A = '/tmp/meridian-raw/case-A.log'
const DSEDT_B = '/tmp/meridian-raw/case-B.log'
const IHM2 = `${process.env.HOME}/ihm2_workspace/src/ihm-backend/storage/logs/11ea28bb7ffd-laravel-2026-09-15.log`

/** 取工具并调用其 execute。 */
async function call(name, args) {
  const tool = registered.find((item) => item.name === name)
  if (tool === undefined) throw new Error(`未注册工具 ${name}`)
  const value = await tool.execute(args, {})
  console.log(`\n${'═'.repeat(72)}\n▶ ${name} ${JSON.stringify(args)}\n${'═'.repeat(72)}`)
  return value
}

// ① 业务对象视角（IHM2 真实日志）
const objects = await call('mer_facts', { log: IHM2, pack: 'ihm2', view: 'object', limit: 2 })
console.log(`  覆盖度: ${objects.coverageNote}`)
console.log(`  技术案例 ${objects.caseCount} 个 ｜ 业务对象 ${objects.objectCount} 个`)
for (const item of objects.objects ?? []) {
  console.log(`  ▸ 单据 ${item.objectId} ｜ ${item.eventCount} 事件 ｜ ${item.attributableMs}ms`)
  for (const ev of item.timeline.slice(0, 3)) console.log(`      ${ev.label} ← ${ev.evidence}`)
}

// ② 判定（DSEDT 正常案例）
const pass = await call('mer_verdict', { log: DSEDT_A })
console.log(`  覆盖度: ${pass.coverageNote}`)
console.log(`  汇总: ${JSON.stringify(pass.summary)}`)

// ③ 判定（漏做「主档」的案例）
const fail = await call('mer_verdict', { log: DSEDT_B })
console.log(`  汇总: ${JSON.stringify(fail.summary)}`)
const bad = (fail.verdicts ?? []).find((item) => item.status === 'failed')
for (const finding of bad?.findings ?? []) {
  console.log(`  · [${finding.kind}/${finding.severity}] ${finding.message}`)
  for (const ev of finding.evidence) console.log(`      证据 ${ev}`)
}

// ④ 基线对比
const base = await call('mer_baseline', { log: DSEDT_B, baseline: DSEDT_A })
console.log(`  ${base.delta.kind} —— ${base.delta.summary}`)

// ⑤ 指引
const guide = await call('mer_guide', {})
console.log(`  内置接入: ${guide.builtinPacks.join(', ')} ｜ 指引 ${guide.guide.length} 字`)

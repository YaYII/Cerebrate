#!/usr/bin/env node
/**
 * 插件冒烟：验证装配契约与工具调用链路——**不联网、不需要密钥**。
 *
 * 本文件干什么：
 *   1. 用最小上下文桩装配插件，确认三个工具都被注册；
 *   2. 跑一次 ts_guide 与 ts_status（注入 fetch 替身）；
 *   3. 跑一次 ts_judge，确认返回是 JSON 安全的工具返回值形状。
 * 本文件不干什么：不做真实连通性验证（那是 scripts/verify-live.ts，需显式运行）。
 *
 * 为什么要有它：单测只覆盖砖块，装配层（defineTool 参数 / 返回契约 / 注入）没有测试就会
 * 在真实 host 加载时才暴露问题——冒烟把这类问题拦在提交前。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** 探测一个 ESM 模块能否导入（用于跳过依赖缺失的环境）。 */
async function moduleAvailable(specifier) {
  try {
    await import(specifier)
    return true
  } catch {
    return false
  }
}

/** 采集注册信息的上下文桩（只需 tools.register 与 on 两个成员）。 */
function createContextStub() {
  const tools = new Map()
  const hooks = []
  return {
    tools,
    hooks,
    ctx: {
      tools: { register: (tool) => tools.set(tool.name, tool) },
      on: (event, handler) => hooks.push({ event, handler }),
    },
  }
}

/** 构造一个返回固定回包的 fetch 替身（冒烟必须离线可跑）。 */
function fetchStub() {
  return async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        model: 'jev-smoke-0.0.0',
        answers: {
          reachable: { type: 'noul', noul: 1 },
          pick: { type: 'choice', choice: 'b', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
  })
}

async function main() {
  // 装配层依赖 DSH 运行时包；本机未安装时跳过冒烟（门禁其余步骤仍有约束力）。
  const hasToolkit = (await moduleAvailable('@deepseek-ai/dsh-tools')) && (await moduleAvailable('@deepseek-ai/schemastery'))
  if (!hasToolkit) {
    process.stdout.write('  ⚠ 跳过插件冒烟：本机缺少 @deepseek-ai/dsh-tools / schemastery（请安装后重跑）\n')
    return
  }
  const entry = join(ROOT, 'lib', 'index.js')
  const plugin = await import(entry)
  const stub = createContextStub()
  plugin.apply(stub.ctx, {
    injectGuidance: true,
    apiKey: 'smoke-key',
    fetchImpl: fetchStub(),
  })

  const expected = ['ts_judge', 'ts_guide', 'ts_status']
  for (const tool of expected) {
    if (!stub.tools.has(tool)) throw new Error('未注册预期工具：' + tool)
  }
  process.stdout.write('注册工具 ' + stub.tools.size + ' 个：' + [...stub.tools.keys()].join(', ') + '\n')
  if (stub.hooks.length !== 1 || stub.hooks[0].event !== 'agent/pre-step') {
    throw new Error('未按预期注册会话首步指引钩子')
  }

  const guide = await stub.tools.get('ts_guide').execute({})
  if (typeof guide.guide !== 'string' || guide.guide.length < 100) throw new Error('ts_guide 未返回有效指引')

  const status = await stub.tools.get('ts_status').execute({})
  if (status.ok !== true || status.servedModel !== 'jev-smoke-0.0.0') throw new Error('ts_status 冒烟失败：' + JSON.stringify(status))

  const judged = await stub.tools.get('ts_judge').execute({
    state: 'smoke test state',
    questions: { reachable: { type: 'noul', instructions: 'Is this a smoke test?' } },
  })
  if (judged.ok !== true) throw new Error('ts_judge 冒烟失败：' + JSON.stringify(judged))
  JSON.stringify(judged) // 返回值必须可 JSON 序列化（工具返回契约）
  if (judged.answers === undefined || judged.answers.reachable === undefined) throw new Error('ts_judge 未返回答案')

  // 错误路径也要冒烟：非法问题必须给出结构化错误，而不是抛穿
  const failed = await stub.tools.get('ts_judge').execute({ state: 'x', questions: {} })
  if (failed.ok !== false || failed.errorKind !== 'invalid') throw new Error('非法入参未返回结构化错误：' + JSON.stringify(failed))

  process.stdout.write('  ✓ 冒烟通过：三个工具注册、调用与错误路径均正常\n')
}

main().catch((error) => {
  process.stderr.write('✗ 冒烟失败：' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exit(1)
})

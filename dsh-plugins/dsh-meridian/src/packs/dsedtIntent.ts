/**
 * DSEDT 核验流程的意图声明 —— AI 对「这段代码应该怎么运行」的显式断言，以数据形式声明。
 *
 * 本文件干什么：声明若干条**按场景绑定**的意图（成功路径 / 拒绝路径 / 并发幂等路径）。
 * 本文件不干什么：不含判定逻辑（逻辑在 features/ruler），不读写文件。
 *
 * 声明依据（真实运行产物，非推测）：2026-09-15 真实测试运行
 * `VerificationServiceImplTest$ConfirmVerifyTest` 的 system-out 中实际出现的活动。
 * 文案与顺序取自日志原文，避免「凭想象写期望」。
 *
 * @module @deepseek-ai/dsh-meridian
 */

import type { Intent } from '../features/ruler'

/** 测试态已知噪音：Redis 为空对象导致的降级与清理失败，属环境噪音而非业务偏离。 */
const TEST_NOISE = [
  { labelContains: '异步落库入队失败' },
  { labelContains: '待归档移除失败' },
  { labelContains: '待归档登记失败' },
  { labelContains: 'confirm分段' },
  { labelContains: '核验抢占失败-单据在读取后被并发改写' },
  { labelContains: '核验抢占未成功-单据状态' },
]

/** DSEDT 意图包。 */
export const DSEDT_INTENTS: Intent[] = [
  {
    name: '核验成功-主档收敛',
    // 适用前提必须锚定**核验写流程**，不能只认 `verified=true`。
    // 真实流量实证（2026-09-15）：仅凭 `verified=true` 会误命中两条**本就不写主档**的路径——
    //   商户查询 `核验结果命中缓存: refId=…, verified=true`（读流程）
    //   幂等重复 `核验命中结果缓存: verified=true`（缓存短路，不重复收敛）
    // 两者都会被判成 failed/漏做「主档落库」，属**假阳性**（误报比漏报更危险）。
    // `核验完成:` 是完成服务在写流程里独有的行，可干净地把三条路径分开。
    appliesWhen: { labelContains: '核验完成:' },
    expect: [
      { name: '核验完成(成功)', match: { labelContains: 'verified=true' }, mustSucceed: true },
      { name: '主档落库(收敛或INSERT兜底)', match: { labelContains: '主档' } },
    ],
    expectEnd: { labelContains: '主档' },
    allow: TEST_NOISE,
  },
  {
    name: '核验拒绝-refId与单据不一致',
    appliesWhen: { labelContains: '核验拒绝-refId与单据不一致' },
    expect: [{ name: '核验完成(未通过)', match: { labelContains: 'verified=false' }, mustSucceed: true }],
    expectEnd: { labelContains: 'verified=false' },
    allow: TEST_NOISE,
  },
  {
    name: '并发核验-幂等返回成功',
    appliesWhen: { labelContains: '核验已完成-幂等返回成功' },
    expect: [{ name: '幂等返回成功', match: { labelContains: '核验已完成-幂等返回成功' }, mustSucceed: true }],
    expectEnd: { labelContains: '幂等返回成功' },
    allow: TEST_NOISE,
  },
]

/**
 * 插件不变量声明 —— 供 DSH host 校验插件装配契约。
 *
 * 本文件干什么：声明本插件注册的工具名集合，供 host 做装配期一致性校验。
 * 本文件不干什么：不含任何判定逻辑。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

/** 本插件注册的工具名（与 src/index.ts 保持一致）。 */
export const TOOL_NAMES = ['ts_judge', 'ts_guide', 'ts_status'] as const

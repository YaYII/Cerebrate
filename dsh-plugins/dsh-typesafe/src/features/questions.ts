/**
 * 问题构造砖块 —— 把三种原语包装成**带校验**的构造函数。
 *
 * 本文件干什么：提供 choice() / noul() / score() 三个构造函数与 spec 校验。
 * 本文件不干什么：不发请求、不做编排、不认识任何业务。
 *
 * 校验规则来自官方文档的硬约束（在调用前失败，比让服务端返回 400 更好定位）：
 * - Choice 至少 2 个判据（只有一个选项就不是「选择」）；
 * - Score 至少 2 个等级（单等级无法表达「程度」）；
 * - instructions 必填（模型看不到问题 id，没有 instructions 就没有判断依据）。
 *
 * @module @deepseek-ai/dsh-typesafe
 */

import { TypeSafeError, type ChoiceCriteria, type QuestionSpec } from './primitives'

/** 构造一个 Choice 问题：从定义好的集合里选一个。 */
export function choice(instructions: unknown, criteria: ChoiceCriteria): QuestionSpec {
  return { type: 'choice', instructions, criteria }
}

/**
 * 构造一个 Noul 问题：判断某个条件是否成立，返回「是」的概率。
 *
 * 注意（官方指引）：Noul 没有单独的 confidence，0.5 附近表示「是/否概率相近」，
 * 而不是「程度中等」。若要问「程度」，用 Score；若有多个标签可能同时成立，
 * 每个标签各用一个 Noul。
 */
export function noul(instructions: unknown): QuestionSpec {
  return { type: 'noul', instructions }
}

/** 构造一个 Score 问题：沿某个维度给出有序程度。等级须能各自成立（不要依赖相邻等级）。 */
export function score(instructions: unknown, levels: string[]): QuestionSpec {
  return { type: 'score', instructions, levels }
}

/** 判断任意值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** 判断 instructions 是否可用（字符串、对象或数组；数字/布尔/空值不足以作为判断依据）。 */
function isUsableInstructions(value: unknown): boolean {
  if (isNonEmptyString(value)) return true
  if (Array.isArray(value)) return value.length > 0
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0
}

/**
 * 校验一条问题声明，返回可用的问题声明。
 *
 * @param id - 问题 id（只用于报错信息；注意它不会发给模型）。
 * @param raw - 来自工具参数的**不可信输入**。
 * @returns 校验通过的规范问题声明。
 * @throws 当类型非法或缺少必要字段时抛出 TypeSafeError（kind=invalid）。
 */
export function validateQuestion(id: string, raw: unknown): QuestionSpec {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeSafeError('invalid', '问题「' + id + '」必须是对象')
  }
  const obj = raw as Record<string, unknown>
  const type = obj.type
  if (type !== 'choice' && type !== 'noul' && type !== 'score') {
    throw new TypeSafeError('invalid', '问题「' + id + '」的 type 必须是 choice / noul / score 之一，实际为 ' + String(type))
  }
  if (!isUsableInstructions(obj.instructions)) {
    throw new TypeSafeError(
      'invalid',
      '问题「' + id + '」缺少可用的 instructions。注意：问题 id 不会发给模型，判断依据必须写进 instructions。',
    )
  }

  if (type === 'choice') {
    const criteria = obj.criteria
    if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new TypeSafeError('invalid', '问题「' + id + '」是 choice，必须提供 criteria 对象（选项键 → 语义说明）')
    }
    const entries = Object.entries(criteria as Record<string, unknown>)
    if (entries.length < 2) {
      throw new TypeSafeError('invalid', '问题「' + id + '」是 choice，criteria 至少需要 2 个选项，实际 ' + entries.length + ' 个')
    }
    const normalized: ChoiceCriteria = {}
    for (const [key, value] of entries) {
      if (!isNonEmptyString(value)) {
        throw new TypeSafeError('invalid', '问题「' + id + '」的 criteria 选项「' + key + '」缺少语义说明（值必须是非空字符串）')
      }
      normalized[key] = value
    }
    return { type: 'choice', instructions: obj.instructions, criteria: normalized }
  }

  if (type === 'score') {
    const levels = obj.levels
    if (!Array.isArray(levels) || levels.length < 2) {
      throw new TypeSafeError('invalid', '问题「' + id + '」是 score，levels 至少需要 2 个等级（从低到高），且每个等级要能独立成立')
    }
    for (const level of levels) {
      if (!isNonEmptyString(level)) {
        throw new TypeSafeError('invalid', '问题「' + id + '」的 levels 每一项都必须是非空字符串')
      }
    }
    return { type: 'score', instructions: obj.instructions, levels: levels as string[] }
  }

  return { type: 'noul', instructions: obj.instructions }
}

/**
 * 校验整份问题表。
 *
 * @param raw - 来自工具参数的问题表（问题 id → 问题声明）。
 * @returns 校验通过的规范问题表。
 * @throws 当问题表为空或任一条不合法时抛出 TypeSafeError。
 */
export function validateQuestions(raw: unknown): Record<string, QuestionSpec> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeSafeError('invalid', 'questions 必须是对象：{ 问题id: { type, instructions, ... } }')
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) {
    throw new TypeSafeError('invalid', 'questions 不能为空：至少需要一道判断')
  }
  const result: Record<string, QuestionSpec> = {}
  for (const [id, spec] of entries) {
    result[id] = validateQuestion(id, spec)
  }
  return result
}

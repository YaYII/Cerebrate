/**
 * Obsidian 团队知识库同步 —— 把 agiteam 阶段产物按规范落盘到团队知识库。
 *
 * 规范（见 团队知识库/IHM2-无息贷款/ 的 README 索引）：
 *   团队知识库/<项目>/<需求大类>/<具体需求>/
 *     ├── 需求清单.md   ← requirements.md
 *     ├── 产品方案.md   ← features.md
 *     ├── 测试用例.md   ← testcases.md
 *     ├── 评审记录.md   ← 评审意见/打回记录
 *     └── 验收报告.md   ← acceptance.md / e2e.md
 *
 * 纯能力砖块：不依赖业务层，只做「读源文件 → 生成规范文件 → 写 vault」。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 团队知识库 vault 根目录（Obsidian vault）。 */
export const KB_VAULT_ROOT = join(process.env.HOME ?? '/home/as-workstation01', 'Documents', 'team-kb', '团队知识库')

/** 知识库规范文件 → 工程产物文件的映射（阶段产物名 → 知识库文件名）。 */
export const KB_FILE_MAP: Record<string, string> = {
  requirements: '需求清单.md',
  features: '产品方案.md',
  testcases: '测试用例.md',
  acceptance: '验收报告.md',
}

/** 工程产物目录相对项目 cwd 的路径。 */
const ARTIFACT_REL: Record<string, string> = {
  requirements: 'requirements/requirements.md',
  features: 'features/features.md',
  testcases: 'testcases/testcases.md',
  acceptance: 'acceptance.md',
}

/** 知识库路径段安全化（中文保留，非法字符替换）。 */
export function safeSegment(name: string): string {
  const normalized = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/^\s+|\s+$/g, '')
  return normalized || `unnamed-${Date.now().toString(36)}`
}

/** 读取工程产物（返回 undefined 表示不存在）。 */
export async function readArtifact(projectCwd: string, artifact: string): Promise<string | undefined> {
  const rel = ARTIFACT_REL[artifact]
  if (!rel) return undefined
  try {
    return await readFile(join(projectCwd, rel), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 把一份工程产物同步为知识库规范文档。
 * @param projectCwd 工程根目录
 * @param kbDir 知识库目标目录（团队知识库/<项目>/<需求大类>/<具体需求>/）
 * @param artifact 产物类型（requirements/features/testcases/acceptance）
 * @returns 写入的文件名；产物不存在返回 undefined
 */
export async function syncArtifactToKb(projectCwd: string, kbDir: string, artifact: string): Promise<string | undefined> {
  const content = await readArtifact(projectCwd, artifact)
  const fileName = KB_FILE_MAP[artifact]
  if (!content || !fileName) return undefined
  // 补 frontmatter（若源文件没有）
  const withMeta = content.includes('---\n')
    ? content
    : [
        '---',
        `created: ${new Date().toISOString().slice(0, 10)}`,
        `updated: ${new Date().toISOString().slice(0, 10)}`,
        `tags: [dsh-agiteam, ${artifact}]`,
        '---',
        '',
        content,
      ].join('\n')
  const absDir = join(KB_VAULT_ROOT, kbDir)
  await mkdir(absDir, { recursive: true })
  const target = join(absDir, fileName)
  await writeFile(target, withMeta, 'utf8')
  return fileName
}

/**
 * 把评审意见/打回记录同步为《评审记录.md》。
 * @param kbDir 知识库目标目录
 * @param stageName 阶段名（需求评审/产品评审/用例评审）
 * @param entries 评审记录行（每条一行文本）
 * @returns 写入的文件名
 */
export async function syncReviewToKb(kbDir: string, stageName: string, entries: string[]): Promise<string> {
  const body = [
    '---',
    `created: ${new Date().toISOString().slice(0, 10)}`,
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    'tags: [dsh-agiteam, 评审记录]',
    '---',
    '',
    `# ${stageName}评审记录`,
    '',
    ...(entries.length > 0 ? entries : ['（暂无评审记录）']),
  ].join('\n')
  const absDir = join(KB_VAULT_ROOT, kbDir)
  await mkdir(absDir, { recursive: true })
  const target = join(absDir, '评审记录.md')
  await writeFile(target, body, 'utf8')
  return '评审记录.md'
}

/** 幂等清理：确保目录存在。 */
export async function ensureKbDir(kbDir: string): Promise<void> {
  await mkdir(join(KB_VAULT_ROOT, kbDir), { recursive: true })
}

/** 审批记录条目（任务板审批日志）。 */
export interface ApprovalRecordEntry {
  /** 时间戳。 */
  time: number
  /** 任务 id。 */
  taskId: string
  /** 任务标题。 */
  title: string
  /** 阶段。 */
  stage: string
  /** 动作（stage-done/stage-approved/stage-rejected/stage-paused/stage-resumed/ai-approval-suggestion）。 */
  action: string
  /** 来源（human/ai/auto）。 */
  source: string
  /** 意见/结果。 */
  comment: string
}

/** 审批记录条目 → 一行文本。 */
export function approvalEntryLine(entry: ApprovalRecordEntry): string {
  const time = new Date(entry.time).toLocaleString('zh-CN', { hour12: false })
  const actionName: Record<string, string> = {
    'stage-done': '提交审批',
    'stage-approved': '审批放行',
    'stage-rejected': '打回返工',
    'stage-paused': '暂停',
    'stage-resumed': '恢复',
    'ai-approval-suggestion': 'AI 建议',
  }
  return `- ${time}｜${actionName[entry.action] ?? entry.action}（${entry.source}）｜${entry.title}｜${entry.comment}`
}

/**
 * 把任务板审批记录同步为《任务板审批记录.md》。
 * @param kbDir 知识库目标目录
 * @param projectName 项目名
 * @param entries 审批记录条目
 * @returns 写入的文件名
 */
export async function syncApprovalsToKb(kbDir: string, projectName: string, entries: ApprovalRecordEntry[]): Promise<string> {
  const body = [
    '---',
    `created: ${new Date().toISOString().slice(0, 10)}`,
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    'tags: [dsh-agiteam, 任务板, 审批记录]',
    '---',
    '',
    `# ${projectName} · 任务板审批记录`,
    '',
    '> 审批权在人（owner）：AI 可提交建议，最终放行/打回由人工决定。',
    '',
    ...(entries.length > 0 ? entries.map(approvalEntryLine) : ['（暂无审批记录）']),
  ].join('\n')
  const absDir = join(KB_VAULT_ROOT, kbDir)
  await mkdir(absDir, { recursive: true })
  const target = join(absDir, '任务板审批记录.md')
  await writeFile(target, body, 'utf8')
  return '任务板审批记录.md'
}

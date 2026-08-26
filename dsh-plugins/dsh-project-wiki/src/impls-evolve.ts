/**
 * wiki_evolve 工具实现——AI 主导的增量知识库刷新。
 *
 * execute 是**顶层导出函数**（executeWikiEvolve，独立可测）；buildEvolveImpl
 * 只做装配引用。流程零件（判变 → 子代理刷新 → 快照同步）均为顶层。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { scanProject } from './scanner'
import { runAiLeadBuild } from './build'
import { diffAgainstSnapshot, evolveTaskText, fileDigests, listWikiPages, loadWikiMeta, saveWikiMeta, sourceDigestOf } from './evolve'
import type { ToolImpl } from './impls'

/** 把项目参数解析为绝对路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/** 刷新快照到当前扫描状态（evolve 成功后调用）。 */
function refreshSnapshot(config: { vaultDir: string; kbRoot: string }, projectDir: string, scan: ReturnType<typeof scanProject>): void {
  saveWikiMeta(config.vaultDir, config.kbRoot, scan.name, {
    project: scan.name,
    sourceRoot: projectDir,
    gitHead: scan.gitHead,
    scannedAt: new Date().toISOString(),
    sourceDigest: sourceDigestOf(scan),
    files: fileDigests(scan),
    pages: listWikiPages(config.vaultDir, config.kbRoot, scan.name),
  })
}

/** wiki_evolve 顶层执行函数（判变 → 子代理刷新 → 快照同步），独立可测。 */
export async function executeWikiEvolve(
  ctx: Context,
  config: { vaultDir: string; kbRoot: string },
  args: Record<string, unknown>,
  exec?: ToolRunContext,
): Promise<Record<string, unknown>> {
  const projectDir = resolveProject(String(args.project ?? ''), process.cwd())
  const scan = scanProject(projectDir)
  const meta = loadWikiMeta(config.vaultDir, config.kbRoot, scan.name)
  const diff = diffAgainstSnapshot(scan, meta)
  if (!diff.changed) {
    return { status: 'ok', data: { project: scan.name, changed: false, reason: diff.reason } }
  }
  // AI 主导增量刷新：提交子代理任务，任务文本携带 diff 信息
  const task = evolveTaskText(scan.name, diff, config.vaultDir, config.kbRoot)
  const result = await runAiLeadBuild({
    ctx,
    projectPath: projectDir,
    vaultDir: config.vaultDir,
    kbRoot: config.kbRoot,
    commit: args.commit !== false,
    taskOverride: task,
    ...(exec?.agent ? { inheritAgent: exec.agent } : {}),
  })
  // 仅成功后刷新快照；失败时保留旧快照，避免误判同步
  if (!result.error) refreshSnapshot(config, projectDir, scan)
  if (result.error) return { status: 'error', message: result.error }
  return { status: 'ok', data: { project: scan.name, changed: true, reason: diff.reason, report: result.report, affectedModules: diff.affectedModules } }
}

/** 构造 wiki_evolve 工具实现（装配顶层函数）。 */
export function buildEvolveImpl(ctx: Context, config: { vaultDir: string; kbRoot: string }): ToolImpl {
  return {
    contractId: 'wiki_evolve',
    execute: (args, exec) => executeWikiEvolve(ctx, config, args, exec),
  }
}

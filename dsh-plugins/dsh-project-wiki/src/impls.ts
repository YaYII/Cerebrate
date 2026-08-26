/**
 * 工具实现注册表——只提供行为；内容永远属于 AI。
 *
 * 每个工具的 execute 逻辑都是**顶层导出函数**（可独立单元测试），
 * buildImpls 只做装配引用——不嵌套闭包，测试零遗漏。
 * 落盘工具与进化工具各自独立成文件，与本文件同构。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { basename, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { projectTree, readFileBounded, topLevelEntries } from './io'
import { scanProject } from './scanner'
import { wikiDirFor } from './writer'
import { runAiLeadBuild } from './build'
import { diffAgainstSnapshot, loadWikiMeta } from './evolve'
import { buildWriteImpl } from './impls-write'
import { buildEvolveImpl } from './impls-evolve'

/** 一个工具实现的契约与行为。 */
export interface ToolImpl {
  contractId: string
  execute: (args: Record<string, unknown>, exec?: ToolRunContext) => Promise<Record<string, unknown>>
}

/** 把项目参数解析为绝对路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

// ── 顶层执行函数（独立可测） ──

/** wiki_tree：列出项目目录树，供 AI 识别模块边界。 */
export async function executeWikiTree(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectDir = resolveProject(String(args.project ?? ''), process.cwd())
  return { status: 'ok', data: { root: projectDir, tree: projectTree(projectDir), top: topLevelEntries(projectDir) } }
}

/** wiki_read：有界读取文件内容。 */
export async function executeWikiRead(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectDir = resolveProject(String(args.project ?? ''), process.cwd())
  const rel = String(args.path ?? '').replace(/\\/g, '/')
  const r = readFileBounded(projectDir, rel)
  return { status: r.found ? 'ok' : 'error', data: r, ...(r.found ? {} : { message: '文件不存在或不可读：' + rel }) }
}

/** wiki_build：提交完整知识库构建任务给子代理。 */
export async function executeWikiBuild(
  ctx: Context,
  config: { vaultDir: string; kbRoot: string },
  args: Record<string, unknown>,
  exec?: ToolRunContext,
): Promise<Record<string, unknown>> {
  const projectDir = resolveProject(String(args.project ?? ''), process.cwd())
  const result = await runAiLeadBuild({
    ctx,
    projectPath: projectDir,
    vaultDir: config.vaultDir,
    kbRoot: config.kbRoot,
    commit: args.commit !== false,
    // 继承调用方（当前主 agent）实际生效的模型路由（requestContext 优先）
    ...(exec?.agent ? { inheritAgent: exec.agent } : {}),
  })
  if (result.error) return { status: 'error', message: result.error }
  return { status: 'ok', data: { project: basename(projectDir), report: result.report, dir: wikiDirFor(config.vaultDir, config.kbRoot, basename(projectDir)) } }
}

/** wiki_status：检查代码与知识库快照同步状态。 */
export async function executeWikiStatus(
  config: { vaultDir: string; kbRoot: string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const projectDir = resolveProject(String(args.project ?? ''), process.cwd())
  const scan = scanProject(projectDir)
  const meta = loadWikiMeta(config.vaultDir, config.kbRoot, scan.name)
  const diff = diffAgainstSnapshot(scan, meta)
  return {
    status: 'ok',
    data: {
      project: scan.name,
      root: projectDir,
      gitHead: scan.gitHead,
      hasSnapshot: meta !== null,
      lastScannedAt: meta?.scannedAt ?? null,
      synced: !diff.changed,
      reason: diff.reason,
      affectedModules: diff.affectedModules,
      newOrModified: diff.newOrModified.slice(0, 20),
      deleted: diff.deleted.slice(0, 20),
      pages: meta?.pages ?? [],
    },
  }
}

// ── 装配注册表：只做引用，不嵌套逻辑 ──

/** 实现注册表：顶层函数装配（落盘/进化独立模块 + 4 个轻量工具）。 */
export function buildImpls(ctx: Context, config: { vaultDir: string; kbRoot: string }): ToolImpl[] {
  return [
    buildWriteImpl(config),
    buildEvolveImpl(ctx, config),
    { contractId: 'wiki_tree', execute: (args) => executeWikiTree(args) },
    { contractId: 'wiki_read', execute: (args) => executeWikiRead(args) },
    { contractId: 'wiki_build', execute: (args, exec) => executeWikiBuild(ctx, config, args, exec) },
    { contractId: 'wiki_status', execute: (args) => executeWikiStatus(config, args) },
  ]
}

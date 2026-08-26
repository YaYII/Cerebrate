/**
 * 工具实现注册表——只提供行为；内容永远属于 AI。
 *
 * 从 index.ts 拆出（功能砖块：装配层只做组合，实现各归其位），
 * 降低装配层圈复杂度，让每个工具实现职责单一、可独立测试。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { basename, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { projectTree, readFileBounded, topLevelEntries, safeVaultPath } from './io'
import { scanProject } from './scanner'
import { sanitizeMermaid, mermaidBlocks } from './mermaid'
import { writePage, vaultCommit, listPages, wikiDirFor } from './writer'
import { runAiLeadBuild } from './build'
import { diffAgainstSnapshot, evolveTaskText, fileDigests, listWikiPages, loadWikiMeta, saveWikiMeta, sourceDigestOf } from './evolve'

/** 一个工具实现的契约与行为。 */
export interface ToolImpl {
  contractId: string
  execute: (args: Record<string, unknown>, exec?: ToolRunContext) => Promise<Record<string, unknown>>
}

/** 把项目参数解析为绝对路径。 */
function resolveProject(project: string | undefined, cwd: string): string {
  return resolve(project ?? cwd)
}

/** 项目的 git 短提交号（非 git 仓库返回空串）。 */
function projectGitHead(projectRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

/**
 * 清洗 Mermaid 块并收集警告（wiki_write 写入前校验步骤 1）。
 * 返回清洗后的正文与警告清单。
 */
export function sanitizeMermaidWarnings(body: string): { body: string; warnings: string[] } {
  const warnings: string[] = []
  const blocks = mermaidBlocks(body)
  if (blocks.length === 0) return { body, warnings }
  let rebuilt = ''
  let cursor = 0
  for (const b of blocks) {
    rebuilt += body.slice(cursor, b.start)
    const { fixed, remaining } = sanitizeMermaid(b.body)
    if (fixed !== b.body) warnings.push('mermaid 块已自动清洗语法风险')
    rebuilt += fixed
    cursor = b.end
    for (const issue of remaining) {
      warnings.push('mermaid 块第 ' + issue.line + ' 行 [' + issue.rule + '] ' + issue.hint)
    }
  }
  return { body: rebuilt + body.slice(cursor), warnings }
}

/**
 * 校验证据引用 <cite>路径</cite> 真实存在（wiki_write 写入前校验步骤 2）。
 * 返回缺失引用警告清单。
 */
export function verifyCiteRefs(body: string, sourceDir: string): string[] {
  const warnings: string[] = []
  const citeRe = /<cite>([^<]+)<\/cite>/g
  let cm: RegExpExecArray | null
  const missing: string[] = []
  while ((cm = citeRe.exec(body)) !== null) {
    const p = cm[1]!.trim().replace(/[()（）:：]$/, '')
    if (p.startsWith('http') || p.includes(' ')) continue
    if (!existsSync(join(sourceDir, p))) missing.push(p)
  }
  if (missing.length > 0) warnings.push('证据引用指向不存在文件：' + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ' 等' + missing.length + ' 处' : ''))
  return warnings
}

/** 实现注册表：6 个工具，行为全部委托给能力层。 */
export function buildImpls(ctx: Context, config: { vaultDir: string; kbRoot: string }): ToolImpl[] {
  return [
    {
      contractId: 'wiki_tree',
      async execute(args) {
        const projectDir = resolveProject(String(args.project ?? ''), process.cwd())
        return { status: 'ok', data: { root: projectDir, tree: projectTree(projectDir), top: topLevelEntries(projectDir) } }
      },
    },
    {
      contractId: 'wiki_read',
      async execute(args) {
        const projectDir = resolveProject(String(args.project ?? ''), process.cwd())
        const rel = String(args.path ?? '').replace(/\\/g, '/')
        const r = readFileBounded(projectDir, rel)
        return { status: r.found ? 'ok' : 'error', data: r, ...(r.found ? {} : { message: '文件不存在或不可读：' + rel }) }
      },
    },
    {
      contractId: 'wiki_write',
      async execute(args) {
        const vault = config.vaultDir
        const kb = config.kbRoot
        const project = String(args.project ?? '').trim()
        const rel = safeVaultPath(String(args.path ?? ''))
        let body = String(args.body ?? '')
        if (!project || !rel || !body) return { status: 'error', message: 'project/path/body 必填' }
        const sourceDir = resolveProject(String(args.source ?? ''), process.cwd())

        // 写入前自动校验：Mermaid 语法风险 + 证据引用文件存在性（独立零件）
        const mermaid = sanitizeMermaidWarnings(body)
        body = mermaid.body
        const warnings = [...mermaid.warnings, ...verifyCiteRefs(body, sourceDir)]

        const gitHead = projectGitHead(sourceDir)
        const res = writePage(vault, kb, project, rel, body, gitHead)
        let committed = false
        let head = ''
        if (args.commit !== false) {
          const stamp = new Date().toISOString().replace(/\.\..+$/, '')
          const c = vaultCommit(vault, 'wiki: ' + project + ' 知识库更新 @ ' + stamp + ' (ai-led)')
          committed = c.committed
          head = c.head
        }
        return { status: 'ok', data: { ...res, committed, vaultHead: head, dir: wikiDirFor(vault, kb, project), ...(warnings.length > 0 ? { warnings } : {}) } }
      },
    },
    {
      contractId: 'wiki_build',
      async execute(args, exec) {
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
      },
    },
    {
      contractId: 'wiki_status',
      async execute(args) {
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
      },
    },
    {
      contractId: 'wiki_evolve',
      async execute(args, exec) {
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
        if (!result.error) {
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
        if (result.error) return { status: 'error', message: result.error }
        return { status: 'ok', data: { project: scan.name, changed: true, reason: diff.reason, report: result.report, affectedModules: diff.affectedModules } }
      },
    },
  ]
}

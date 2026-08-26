/**
 * wiki_write 工具实现——页面落盘（校验 + 写入 + git 提交）。
 *
 * execute 是**顶层导出函数**（executeWikiWrite，独立可测）；buildWriteImpl
 * 只做装配引用。校验零件（Mermaid 清洗/证据校验）同为顶层导出。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { safeVaultPath } from './io'
import { sanitizeMermaid, mermaidBlocks } from './mermaid'
import { writePage, vaultCommit, wikiDirFor } from './writer'
import type { ToolImpl } from './impls'

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
 * 清洗 Mermaid 块并收集警告（写入前校验步骤 1）。
 * 对正文中每个 mermaid 围栏做语法风险清洗，残余风险转警告。
 * @param body - 待校验的 Markdown 正文。
 * @returns 清洗后的正文与警告清单。
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
 * 校验证据引用 <cite>路径</cite> 真实存在（写入前校验步骤 2）。
 * http 链接与含空格路径跳过（外部引用/描述性文本不校验）。
 * @param body - 待校验的 Markdown 正文。
 * @param sourceDir - 源码根目录（相对引用以它解析）。
 * @returns 缺失引用警告清单。
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

/**
 * wiki_write 顶层执行函数（校验 + 落盘 + git 提交），独立可测。
 * @param config - vault 目录与知识库根目录配置。
 * @param args - 工具入参：project（知识库项目名）/path（vault 相对路径）/body（Markdown 正文）/source（源码目录）/commit（是否 git 提交）。
 * @returns 状态与数据：{ status, data: { path, written, changed, committed, vaultHead, dir, warnings } }。
 */
export async function executeWikiWrite(
  config: { vaultDir: string; kbRoot: string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
}

/** 构造 wiki_write 工具实现（装配顶层函数）。 */
export function buildWriteImpl(config: { vaultDir: string; kbRoot: string }): ToolImpl {
  return {
    contractId: 'wiki_write',
    execute: (args) => executeWikiWrite(config, args),
  }
}

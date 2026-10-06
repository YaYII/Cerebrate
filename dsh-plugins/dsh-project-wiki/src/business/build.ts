/**
 * AI 主导的知识库构建编排器。
 *
 * wiki_build 把一个「构建知识库」的任务提交给 DSH 子代理（即 AI 本身）：
 * 子代理用 wiki_tree/wiki_read 浏览项目、自主判断模块边界与页面规划、
 * 逐页撰写内容，并用 wiki_write 落盘。本插件从不解析代码、从不生成内容——
 * 它只提供 AI 的工具与落盘通道。这是生态契约：万物为 AI 服务。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 一次完整 AI 构建的结果。 */
export interface BuildResult {
  /** 子代理的最终消息（它自己总结的构建成果）。 */
  report: string
  /** 子代理未能完成时的错误说明（中文、可操作）。 */
  error?: string
}

/**
 * 向全新的 DSH 子代理提交一次 wiki 构建。
 *
 * 子代理获得浏览/写入工具与项目根工作目录；内容完全由 AI 产出。
 */
export async function submitWikiBuild(opts: {
  ctx: Context
  projectPath: string
  vaultDir: string
  kbRoot: string
  task: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
  /**
   * 调用方（当前主 agent）——其会话的 requestContext 提供「用户当前实际
   * 使用的模型路由」这一权威信号，优先于静态 options（常为空）与部署默认
   * 配置（常已过期）。
   */
  inheritAgent?: { session: { requestContext?: () => { provider?: string; model?: string } | undefined }; options?: { provider?: string; model?: string } }
  /** 自定义任务文本（wiki_evolve 传入增量刷新任务）。 */
  taskOverride?: string
}): Promise<BuildResult> {
  const { ctx, projectPath, vaultDir, kbRoot, task, taskOverride, signal } = opts

  const agents = ctx.get('agents')
  if (!agents) return { report: '', error: 'DSH 代理注册表不可用（缺少 ctx.agents）' }

  const sessionId = ('wiki-build-' + randomUUID()) as SessionId
  opts.onProgress?.('启动 AI 构建子代理：' + projectPath)

  // 模型继承：优先读调用方（当前主 agent）实际生效的模型路由
  // （session.requestContext = 最近一次请求解析出的 provider/model，
  // 用户或系统动态切换后这里始终是最新值），回退到静态 options。
  // 不读全局默认配置（可能过期或与路由不匹配），不固定任何模型（模型会动态更新）。
  const live = opts.inheritAgent?.session.requestContext?.()
  const parentOptions = live?.provider && live?.model
    ? { provider: live.provider, model: live.model }
    : opts.inheritAgent?.options?.provider && opts.inheritAgent?.options?.model
      ? { provider: opts.inheritAgent.options.provider, model: opts.inheritAgent.options.model }
      : undefined

  // 创建子代理（继承调用方模型路由，父进程组合工具世界）
  const handle = await createBuildAgent(agents, sessionId, projectPath, parentOptions, signal)
  if (handle === null) return { report: '', error: '创建构建子代理失败' }
  // 驱动子代理执行任务并收集结果
  return driveBuild(handle, taskOverride ?? task)
}

/**
 * 创建构建子代理：继承调用方的模型路由（若可用），并挂载父进程的工具组合。
 * 创建失败时返回 null（错误已由调用方统一报告）。
 */
async function createBuildAgent(
  agents: import('@deepseek-ai/dsh-agent').AgentRegistry,
  sessionId: SessionId,
  projectPath: string,
  parentOptions: { provider: string; model: string } | undefined,
  signal: AbortSignal | undefined,
): Promise<AgentHandle | null> {
  try {
    return await agents.create({
      sessionId,
      meta: {
        cwd: projectPath,
        origin: 'subagent',
        agentPreset: 'code',
      },
      ...(parentOptions ? { agentOptions: parentOptions } : {}),
      ...(signal ? { signal } : {}),
      setup: () => {
        // 子代理继承插件的组合工具世界（浏览/写入工具由本插件注册）；
        // 内容完全由 AI 产出，此处无需额外装配。
      },
    })
  } catch {
    return null
  }
}

/**
 * 驱动子代理执行任务并等待完成，返回构建结果或错误。
 * 无论成功失败都会释放子代理句柄。
 */
async function driveBuild(handle: AgentHandle, task: string): Promise<BuildResult> {
  const agent = handle.agent
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'dsh-project-wiki' },
    }))
    await agent.whenIdle()
    const outcome = extractOutcome(agent)
    await handle.dispose()
    return { report: outcome.report, ...(outcome.error ? { error: outcome.error } : {}) }
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    try { await handle.dispose() } catch { /* 已释放，忽略 */ }
    return { report: '', error: msg }
  }
}

/**
 * 从会话事件日志提取构建结果：最后一条助手文本，以及当最终轮次以错误
 * 结束时（例如提供方配额/余额不足）该错误——保证 wiki_build 不会在失败
 * 时误报空成功。遍历完整事件数组（而非 surface，后者可能丢弃 turn/end
 * 与工具事件），确保失败的轮次可靠上报错误。
 */
function extractOutcome(agent: { session: { snapshotEvents(): readonly unknown[] } }): { report: string; error?: string } {
  const events = agent.session.snapshotEvents()
  let report = ''
  let turnError = ''
  for (const raw of events) {
    const e = raw as {
      type?: string
      data?: { content?: Array<{ type: string; text?: string }>; reason?: { kind?: string; error?: { message?: string; code?: string } } }
    } | undefined
    if (!e?.type) continue
    if (!report && e.type === 'assistant/message' && Array.isArray(e.data?.content)) {
      const text = (e.data.content as Array<{ type: string; text?: string }>).map(c => c.text ?? '').join('')
      if (text.trim()) report = text.trim()
    }
    if (e.type === 'turn/end') {
      const reason = e.data?.reason
      if (reason?.kind === 'error') {
        turnError = 'LLM 调用失败：' + (reason.error?.message ?? '') + ' (code ' + (reason.error?.code ?? '') + ')'
      }
    }
  }
  return { report, ...(turnError ? { error: turnError } : {}) }
}

/** 构建传给子代理的 AI 主导工作流任务文本。 */
export function buildTaskText(projectName: string, vaultDir: string, kbRoot: string, commit: boolean): string {
  return [
    '# 任务：为项目「' + projectName + '」构建 AI 知识库',
    '',
    '你是本项目的架构分析师与文档作者。目标：让任何 AI 与工程师通过知识库真正理解这个系统。',
    '',
    '## 第一步：认识项目（不预设假设）',
    '- 用 wiki_tree project=<路径> 查看真实目录结构；',
    '- 项目根目录可能只是工作区容器：backend/、frontend/、docker/、database/、docs/ 等才是真实模块；',
    '- 用 wiki_read project=<路径> path=<相对路径> 读取 README、AGENTS.md、package.json/pom.xml、docker-compose.yml 以及各模块入口文件；',
    '- 在笔记里记录：模块边界、技术栈、业务链路、关键配置。',
    '',
    '## 第二步：规划知识库结构（由 AI 决定，不是模板）',
    '- 知识库根目录：' + vaultDir + '/' + kbRoot + '/' + projectName + '/',
    '- 每个真实模块是独立的知识区域：如 01-系统架构/、02-前端/、03-后端/、04-数据库/、05-部署运维/、06-业务域/；',
    '- 页面数量与复杂度成正比，模块逐个成页：',
    '  * <模块>/README.md —— 该模块的定位、边界、技术栈、关键链路（带 Mermaid 架构图）',
    '  * <模块>/<业务或技术主题>.md —— 深入主题（接口契约、数据流、设计决策、排障）',
    '- 计划写完后，在 ' + vaultDir + '/' + kbRoot + '/' + projectName + '/README.md 写总览索引。',
    '',
    '## 第三步：逐模块撰写（每页必须）',
    '1. 以 `# 标题` 开头；',
    '2. 多用图表达（图 > 文字，效果强 100 倍）：',
    '   - 每个模块 README 至少一个 ```mermaid mindmap 思维导图——表达模块内部结构/知识骨架（根节点用 root((模块名))，子节点缩进表达层级）；',
    '   - 流程用 flowchart（业务链路/时序）；架构用 flowchart 分层图（装配层/业务层/功能层）；',
    '   - 节点名必须来自真实代码（类名/服务名/函数名）；',
    '3. 论断附证据引用：`<cite>路径</cite>` 或 `（路径:行号）`——引用的文件必须真实存在；',
    '4. 只写你真实读过的东西，禁止编造 API、模块、行号；',
    '5. 中文撰写，术语保留原名。',
    '',
    '## Mermaid 安全写法（违反会导致 Obsidian 渲染失败）',
    '1. 节点文本一律用引号：`ID["文本含 / 或 : 或 () 或 {} 时"]`；',
    '2. subgraph 标题禁止含 /（斜杠）——用「与」代替；',
    '3. 节点文本禁止写函数调用（如 `sha256Hex(x).substring(0,40)`）——用文字描述（如「sha256Hex 截取前40位」）；',
    '4. 节点文本禁止花括号 {}（会触发菱形解析）——写「mpay:nonce 值」而非「mpay:nonce:{nonce}」；',
    '5. 边标签 |...| 禁止 <br/> 与 {}——标签用短文本，换行说明移入节点；',
    '6. 禁止 [/text/] 平行四边形形状语法——一律 ["text"]；',
    '7. 菱形节点文本结尾不要带 ?（如写「是否启用」而非「启用?」）。',
    '',
    '## 操作链路与部署类内容（必须写全，防止读者断片）',
    '1. 涉及多机/多环境操作（部署/上传/同步）时，必须写清【每步在哪台机器上执行】（本地/堡垒机/跳板机/目标节点）；',
    '2. 按「打包 → 上传 → 中转 → 分发 → 生效 → 验证」完整链路描述，不许跳过中间环节；',
    '3. 命令必须给出执行位置上下文（如「181 上执行」「本地执行」），并标注验证命令；',
    '4. 若有权威运维文档（如 DEPLOY.md、docs/ 下操作手册），先读并以其为准。',
    '',
    '## 第四步：分页落盘（关键——防超时中断丢失进度）',
    '- **每完成一页立即**用 wiki_write project=<项目名> path=<相对路径> body=<Markdown> commit=' + commit + ' 写入——不要攒到最后批量写；',
    '- **分模块推进**：先写 01-系统架构（1-2 页）→ 落盘 → 再写 02-功能层（2-3 页）→ 落盘 → 依此类推；每批 2-3 页就是一个检查点；',
    '- **中断续传**：若任务被中断（工具超时/进程重启），已落盘的页面在 vault 中保留；重新调用 wiki_status 查看进度，再用 wiki_evolve 或 wiki_build 继续未完成的模块——不要重复写已存在的页面（先 wiki_tree 回读 vault 确认）；',
    '- 全部完成后用 wiki_tree 回读 vault 验证页数与结构；',
    '- 最后用一句话总结：知识库结构、页数、覆盖模块。',
    '',
    '> 记住：知识库是给后续 AI 与工程师看的 —— 重点写清架构决策、业务链路、模块边界。',
    '> 长文档（超过 10 页）尤其要分批落盘：页面一旦写入 vault 就是安全的，中断只是暂停，不是失败。',
  ].join('\n')
}

/** 同步执行一次 AI 主导构建（供 wiki_build 工具执行时调用）。 */
export async function runAiLeadBuild(opts: {
  ctx: Context
  projectPath: string
  vaultDir: string
  kbRoot: string
  commit: boolean
  signal?: AbortSignal
  onProgress?: (message: string) => void
  inheritAgent?: { session: { requestContext?: () => { provider?: string; model?: string } | undefined }; options?: { provider?: string; model?: string } }
  taskOverride?: string
}): Promise<BuildResult> {
  const name = opts.projectPath.split('/').filter(Boolean).pop() ?? 'project'
  const task = opts.taskOverride ?? buildTaskText(name, opts.vaultDir, opts.kbRoot, opts.commit)
  return submitWikiBuild({
    ctx: opts.ctx,
    projectPath: opts.projectPath,
    vaultDir: opts.vaultDir,
    kbRoot: opts.kbRoot,
    task,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.inheritAgent ? { inheritAgent: opts.inheritAgent } : {}),
    ...(opts.taskOverride ? { taskOverride: opts.taskOverride } : {}),
  })
}

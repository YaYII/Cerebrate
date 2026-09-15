/**
 * dsh-agiteam —— AGI 团队开发引擎。
 *
 * 接到需求后，由多个不同角色（子 agent）按传统软件团队流程协作：
 *
 *   需求 → 需求分析(需求清单) → 需求评审 → 产品设计(产品功能清单)
 *        → 产品评审 → 测试用例设计(功能↔用例矩阵) → 测试用例评审
 *        → 正式开发(每功能点实现+单元测试) → 逐功能验收(单测+API+脚本)
 *        → 模拟用户场景端到端验收 → 交付
 *
 * 每个阶段由对应角色子 agent 执行，评审阶段自动判定 通过/打回，
 * 打回带意见回到上一阶段返工。阶段产物渲染为 Markdown 落盘
 * artifactsDir 并回灌对话（修复 pipeline-kernel "只有标题没内容"缺陷）。
 *
 * 架构分层：本文件是装配层（工具注册 + 引导注入），行为在 business/
 * （engine.ts 编排 + tools.ts 顶层 execute + roles.ts 角色定义），
 * 纯能力在 features/（stage/model/render/runner）。
 *
 * @module @deepseek-ai/dsh-agiteam
 */

import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  executeAssign,
  executeAdvance,
  executeAiApprove,
  executeApprove,
  executeAutoDone,
  executeNewRequirement,
  executePause,
  executeReadArtifact,
  executeRegister,
  executeReject,
  executeResume,
  executeReview,
  executeRoleTask,
  executeRunAcceptance,
  executeStartProject,
  executeStatus,
  executeTaskList,
} from './business/tools'
import { executeQoderTask } from './business/qoder'
import { registerWebSurface } from './business/web'
import { runtimeFromCtx } from './business/engine'
import type { TeamRole } from './business/roles'
import { ROLE_NAMES } from './business/roles'

/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
export const name = 'dsh-agiteam'
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 产物目录名（相对项目 cwd）。 */
  artifactsDir: string
  /** 是否在首个 step 注入团队流程引导。 */
  injectGuidance: boolean
  /** taskboard 数据库路径（复用底座 SQLite；空则用默认路径）。 */
  taskboardDatabasePath: string
  /** taskboard 附件根目录（空则用默认路径）。 */
  taskboardAttachmentRoot: string
}

/** Schemastery 配置模式。 */
export const Config: z<Config> = z.object({
  artifactsDir: z.string().default('.teamdev'),
  injectGuidance: z.boolean().default(true),
  taskboardDatabasePath: z.string().default(''),
  taskboardAttachmentRoot: z.string().default(''),
})

/** 折叠进首个 agent step 的团队流程引导。 */
const TEAM_GUIDANCE = [
  '【dsh-agiteam】本会话具备 AGI 团队开发引擎（agiteam_* 工具），采用「项目制 + 需求制 + 阶段会话 + 项目记忆」工程化管理：',
  '1. 项目制：agiteam_start 创建项目（工程根目录 + requirements/features/testcases/code/tests/scripts/docs 子目录 + 数据库项目记录）。项目是工程单位，不是散乱会话。',
  '2. 需求制：每次对话 = 一个需求。agiteam_new_requirement 在项目内新建需求（自动编号 R-N），走完整流程：需求分析 → 需求确认(评审) → 需求执行(落实到产品功能点) → 开发 → 验收。',
  '3. 阶段会话：每个需求×阶段用专属会话（session-<项目>-<需求>-<阶段>），AI 在该会话完成对应阶段；出问题可续聊或开新会话（带项目记忆，避免历史错误误导）。',
  '4. 项目记忆：同一项目内所有需求的上下文/决策/踩坑按记忆规则共享（cerebrate project_id=<项目名>），换会话也能继续。',
  '流程：需求分析(需求清单) → 需求评审 → 产品设计(产品功能清单) → 产品评审 → 测试用例设计(用例矩阵) → 测试用例评审 → 正式开发(每功能点+单测) → 逐功能验收(单测+API+脚本) → 端到端验收 → 交付。',
  '用法：agiteam_start（建项目，可传 kbPath 指定团队知识库路径，产物自动落盘 Obsidian）→ agiteam_new_requirement（项目内新建需求）→ 角色自动接力（agiteam_done 推进 / agiteam_review 评审）→ agiteam_status（查状态）→ agiteam_artifact（读产物）。',
  '追溯登记（每完成一个实体必须登记）：agiteam_register 登记需求/功能/用例/单测/代码/验收脚本；agiteam_run_acceptance 执行验收脚本（真实命令）并记录日志。',
  '每个阶段由对应角色子 agent 执行；评审阶段（需求评审/产品评审/用例评审）自动判定 通过/打回，打回带意见回到上一阶段返工。',
  '知识库落盘：项目配置 kbPath 后，阶段产物按规范自动写入团队知识库（需求清单.md/产品方案.md/测试用例.md/验收报告.md/评审记录.md）；角色完成后自动通知发起会话继续指挥。',
].join('\n')

/** 本包注入消息的来源插件标签。 */
const PLUGIN_TAG = 'dsh-agiteam'

/** 角色枚举（工具参数用）。 */
const ROLE_ENUM = Object.keys(ROLE_NAMES)

/** 引导消息是否已存在于会话可见面。 */
function guidanceAlreadyInjected(agent: Agent): boolean {
  return agent.session.surface.nodes.some((seq) => {
    // Session.events 已在 dsh 0.1.5 移除，改用等价的 eventAt(seq) 单事件读取
    const event = agent.session.eventAt(seq)
    return event?.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === PLUGIN_TAG
  })
}

/** 把工具返回值以美化 JSON 文本呈现给模型。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** agiteam 工具的通用 UI 卡片。 */
function presentCall(title: string, args: unknown) {
  return { card: 'generic' as const, title, kind: 'other' as const, rawInput: args }
}

/**
 * 注册 `agiteam_*` 工具集，并按配置在首个 agent step 注入团队流程引导。
 * 每个工具的 execute 委托给 business 层顶层函数（可独立测试）。
 * @param ctx - 携带工具注册表的注册上下文。
 * @param config - 插件配置。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const toolConfig = { artifactsDir: config.artifactsDir, injectGuidance: config.injectGuidance }

  // ── taskboard 底座 host 注册（复用其 apply：TaskboardService + 工具 + automation worker）──
  // 说明：taskboard 是 vendored Apache-2.0 底座，host 由 tsc 预编译（lib/taskboard-host，
  // tsc 转换 @Remote 装饰器；tsdown/rolldown 不转）。Cordis 的 fiber 机制会 await async
  // apply（registry.plugin → fiber.await），所以本 apply 声明为 async，内部用原生
  // await import 加载 taskboard-host（ESM）——避免 CJS require(esm) 在 tsx loader 下
  // 报 "module not been linked"（Node 22 require(esm) 同步链路对复杂模块图不稳定）。
  // 用 createRequire.resolve 解析真实路径 + pathToFileURL 转 file URL，
  // 让 tsdown 打包器不静态分析该动态 import（变量形式不会被打包内联）。
  try {
    const requireFromLib = createRequire(import.meta.url)
    const tbPath = requireFromLib.resolve('../lib/taskboard-host/index.js')
    const tbHost = await import(pathToFileURL(tbPath).href) as {
      apply(ctx: Context, config: Record<string, unknown>): void
    }
    tbHost.apply(ctx, {
      databasePath: config.taskboardDatabasePath || '/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard.sqlite',
      attachmentRoot: config.taskboardAttachmentRoot || '/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard-attachments',
    })
    // 为所有已有项目 ensure 默认自动化规则（enabled）：任务批准（approve→todo）后
    // coordinator 自动扫描 → claim → 启动 agent 执行 → 提交审批。这是"批准执行"的引擎。
    void ensureDefaultAutomationRules()
  } catch (err) {
    // taskboard 底座注册失败不阻断 agiteam（工具仍可用，只是无底座 UI/服务）
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    console.error(`[dsh-agiteam] taskboard 底座注册失败（将使用回退存储）:\n${detail}`)
  }

  const tools = {
    start: defineTool({
      name: 'agiteam_start',
      description: '【启动团队开发项目】输入项目名与原始需求，启动完整 AGI 团队开发流程（需求分析→评审→产品→用例→开发→验收）。返回项目 id 与当前阶段。kbPath 可选：团队知识库相对路径（团队知识库/<项目>/<需求大类>/<具体需求>/），产物会自动按规范落盘 Obsidian。',
      parameters: {
        projectName: { type: 'string', required: true, description: '项目/需求名称' },
        requirement: { type: 'string', required: true, description: '原始需求描述（完整内容）' },
        projectId: { type: 'string', description: '可选：自定义项目 id（默认由项目名生成）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
        kbPath: { type: 'string', description: '可选：团队知识库相对路径（如 IHM2-无息贷款/日志服务/无息贷款操作日志服务），产物自动落盘 Obsidian' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectName: string; requirement: string; projectId?: string; cwd?: string; kbPath?: string }) =>
        executeStartProject(ctx, toolConfig, args),
      presentCall: args => presentCall('启动团队开发项目', args),
    }),
    status: defineTool({
      name: 'agiteam_status',
      description: '【查询团队开发项目状态】返回项目当前阶段、已完成阶段、评审意见与产物清单。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; cwd?: string }) => executeStatus(ctx, toolConfig, args),
      presentCall: args => presentCall('查询项目状态', args),
    }),
    advance: defineTool({
      name: 'agiteam_advance',
      description: '【推进阶段/评审门禁】当前阶段完成后调用：passed=true 进入下一阶段；评审阶段 passed=false 打回上一阶段返工（可附评审意见）。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        passed: { type: 'boolean', required: true, description: '是否通过（评审门禁：true=通过放行，false=打回返工）' },
        comment: { type: 'string', description: '可选：评审意见/打回原因' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; passed: boolean; comment?: string; cwd?: string }) =>
        executeAdvance(ctx, toolConfig, args),
      presentCall: args => presentCall('推进阶段', args),
    }),
    task: defineTool({
      name: 'agiteam_task',
      description: '【分派角色任务】向指定角色子 agent 分派一项具体任务（如"请产出需求清单"）。角色：' + ROLE_ENUM.join('/'),
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        role: { type: 'string', required: true, enum: ROLE_ENUM, description: '目标角色' },
        task: { type: 'string', required: true, description: '任务内容（完整指令）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; role: TeamRole; task: string; cwd?: string }) =>
        executeRoleTask(ctx, toolConfig, args),
      presentCall: args => presentCall('分派角色任务', args),
    }),
    qoder: defineTool({
      name: 'agiteam_qoder',
      description: '【指挥 Qoder CLI 干活】把 Qoder（独立 CLI 智能体）作为可指挥角色：在项目工作目录用非交互模式执行任务（代码审查/测试编写/文档生成等）。返回 Qoder 输出与退出码。model 可选指定 Qoder 模型（如 Qwen3.8-Max），缺省用其默认模型。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id（工作目录 = 项目 cwd）' },
        task: { type: 'string', required: true, description: '任务指令（完整 prompt，Qoder 按它执行）' },
        model: { type: 'string', description: '可选：指定 Qoder 模型（如 Qwen3.8-Max/Qwen3.8-Flash/Kimi-K2.7-Code）' },
        cwd: { type: 'string', description: '可选：覆盖工作目录（默认项目 cwd）' },
        timeoutMs: { type: 'number', description: '可选：超时毫秒（默认 600000=10 分钟）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; task: string; model?: string; cwd?: string; timeoutMs?: number }) =>
        executeQoderTask(ctx, toolConfig, args),
      presentCall: args => presentCall('指挥 Qoder 干活', args),
    }),
    artifact: defineTool({
      name: 'agiteam_artifact',
      description: '【读取阶段产物】读取需求清单/产品功能清单/测试用例矩阵/验收报告等阶段产物全文。artifact 取值：requirements/features/testcases/acceptance/e2e。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        artifact: { type: 'string', required: true, enum: ['requirements', 'features', 'testcases', 'acceptance', 'e2e'], description: '产物名' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; artifact: string; cwd?: string }) =>
        executeReadArtifact(ctx, toolConfig, args),
      presentCall: args => presentCall('读取阶段产物', args),
    }),
    register: defineTool({
      name: 'agiteam_register',
      description: '【登记追溯实体】角色 agent 每完成一个实体（需求/功能/用例/单测/代码/脚本）后调用，写入审计日志（带指纹），成为追溯矩阵与多层校验的数据源。action 取值：register-requirement（需求）/register-feature（功能）/register-testcase（用例）/register-unittest（单测）/register-codefile（代码）/register-script（脚本）。detail 为实体 JSON。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        role: { type: 'string', required: true, description: '执行角色（requirement/product/test-designer/developer/tester 等）' },
        stage: { type: 'string', required: true, description: '当前阶段（requirement/product/testcase/develop/feature-accept 等）' },
        action: { type: 'string', required: true, enum: ['register-requirement', 'register-feature', 'register-testcase', 'register-unittest', 'register-codefile', 'register-script'], description: '登记动作类型' },
        detail: { type: 'string', required: true, description: '实体 JSON（如 {"id":"F-1","name":"登录","requirementIds":["R-1"]}）' },
        fingerprint: { type: 'string', description: '可选：数据指纹（如文件 sha256），用于审计校验' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; role: string; stage: string; action: string; detail: string; fingerprint?: string; cwd?: string }) =>
        executeRegister(ctx, toolConfig, args),
      presentCall: args => presentCall('登记追溯实体', args),
    }),
    runAcceptance: defineTool({
      name: 'agiteam_run_acceptance',
      description: '【执行验收脚本】测试验收员运行真实命令（API 模拟请求/自动化脚本），记录运行日志文件 + 登记审计（脚本层/日志层证据）。返回退出码/耗时/日志路径。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        role: { type: 'string', required: true, description: '执行角色（tester）' },
        stage: { type: 'string', required: true, description: '当前阶段（feature-accept/e2e-accept）' },
        scriptId: { type: 'string', required: true, description: '验收脚本编号（AS-1 等）' },
        featureId: { type: 'string', required: true, description: '关联功能编号（F-1 等）' },
        path: { type: 'string', required: true, description: '脚本相对路径（如 scripts/accept-login.sh）' },
        kind: { type: 'string', required: true, enum: ['api', 'ui', 'script'], description: '脚本类型' },
        command: { type: 'string', required: true, description: '要执行的完整命令（如 curl ... 或 node scripts/e2e.mjs）' },
        argsList: { type: 'array', items: { type: 'string' }, description: '命令参数列表' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 120000）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; role: string; stage: string; scriptId: string; featureId: string; path: string; kind: 'api' | 'ui' | 'script'; command: string; argsList?: string[]; timeoutMs?: number; cwd?: string }) =>
        executeRunAcceptance(ctx, toolConfig, args),
      presentCall: args => presentCall('执行验收脚本', args),
    }),
    done: defineTool({
      name: 'agiteam_done',
      description: '【阶段完成自动推进】角色完成当前阶段任务后调用，自动推进到下一阶段并唤醒下一角色（全自动驱动，无需手动 advance）。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        result: { type: 'string', required: true, description: '完成结果描述（产物路径/结论）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; result: string; cwd?: string }) =>
        executeAutoDone(ctx, toolConfig, args),
      presentCall: args => presentCall('阶段完成自动推进', args),
    }),
    newRequirement: defineTool({
      name: 'agiteam_new_requirement',
      description: '【项目内新建需求】在已有项目内新建一个需求（每次对话 = 一个需求），自动进入该需求的需求分析（阶段会话）。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        requirement: { type: 'string', required: true, description: '需求描述（完整内容）' },
        title: { type: 'string', description: '可选：需求标题（默认 需求 R-N）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; requirement: string; title?: string; cwd?: string }) =>
        executeNewRequirement(ctx, toolConfig, args),
      presentCall: args => presentCall('项目内新建需求', args),
    }),
    review: defineTool({
      name: 'agiteam_review',
      description: '【评审判定】评审角色判定 通过/打回：passed=true 自动前进到下一阶段；passed=false 带意见打回上一阶段返工。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        passed: { type: 'boolean', required: true, description: '是否通过评审' },
        comment: { type: 'string', description: '评审意见（打回时必填原因）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; passed: boolean; comment?: string; cwd?: string }) =>
        executeReview(ctx, toolConfig, args),
      presentCall: args => presentCall('评审判定', args),
    }),
    approve: defineTool({
      name: 'agiteam_approve',
      description: '【人工审批放行】你是唯一审批人：任务提交 in_review 后，approve 放行并推进到下一阶段。可附审批意见。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        comment: { type: 'string', description: '可选：审批意见' },
        advance: { type: 'boolean', description: '是否立即推进下一阶段（默认 true）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; comment?: string; advance?: boolean; cwd?: string }) =>
        executeApprove(ctx, toolConfig, args),
      presentCall: args => presentCall('人工审批放行', args),
    }),
    reject: defineTool({
      name: 'agiteam_reject',
      description: '【人工打回】你是唯一审批人：打回任务并带意见返回上一阶段（或当前阶段）返工。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        comment: { type: 'string', required: true, description: '打回原因（必填）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; comment: string; cwd?: string }) =>
        executeReject(ctx, toolConfig, args),
      presentCall: args => presentCall('人工打回', args),
    }),
    pause: defineTool({
      name: 'agiteam_pause',
      description: '【暂停任务】随时暂停当前阶段任务（你是魔王）。暂停的任务不会自动推进；恢复用 agiteam_resume。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        reason: { type: 'string', required: true, description: '暂停原因（必填）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; reason: string; cwd?: string }) =>
        executePause(ctx, toolConfig, args),
      presentCall: args => presentCall('暂停任务', args),
    }),
    resume: defineTool({
      name: 'agiteam_resume',
      description: '【恢复任务】恢复暂停的任务，角色继续当前阶段工作。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; cwd?: string }) =>
        executeResume(ctx, toolConfig, args),
      presentCall: args => presentCall('恢复任务', args),
    }),
    aiApprove: defineTool({
      name: 'agiteam_ai_approve',
      description: '【AI 代为审批】AI 依据验收标准给出审批建议（建议放行/打回），提交到任务。最终放行权在你：agiteam_approve / agiteam_reject。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        suggestion: { type: 'string', required: true, description: 'AI 审批建议（依据/结论）' },
        approve: { type: 'boolean', description: 'AI 建议：true=放行，false=打回（默认 true）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; suggestion: string; approve?: boolean; cwd?: string }) =>
        executeAiApprove(ctx, toolConfig, args),
      presentCall: args => presentCall('AI 代为审批', args),
    }),
    assign: defineTool({
      name: 'agiteam_assign',
      description: '【主管分派执行者】给 taskboard 任务指派执行智能体（写入任务 source.executorPreset，coordinator 自动启动该 agent 执行）。executor 可选：code（通用）/requirement/product/developer/tester/architect 等角色，或任意已装 preset id。dependsOn 可选：前置任务 id 数组（先完成的任务），自动建 blocks 依赖——顺序编排如"单测必须在代码写完后"。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id（taskboard 的 task id 或 identifier 如 MF-2）' },
        executor: { type: 'string', required: true, description: '执行者 preset：code/requirement/product/developer/tester/architect/req-reviewer/prod-reviewer/test-designer/supervisor' },
        note: { type: 'string', description: '可选：分派说明' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '可选：前置任务 id/identifier 数组（如 ["MF-1"]，表示 MF-1 完成后才执行本任务）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { taskId: string; executor: string; note?: string; dependsOn?: string[] }) =>
        executeAssign(ctx, toolConfig, args),
      presentCall: args => presentCall('主管分派执行者', args),
    }),
    taskList: defineTool({
      name: 'agiteam_task_list',
      description: '【任务板列表】查看项目任务板全部任务及状态（含审批状态/会话/审批建议）。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 id' },
        status: { type: 'string', description: '可选：按状态过滤（open/claimed/in_progress/in_review/paused/done/failed/rejected）' },
        cwd: { type: 'string', description: '可选：项目工作目录（默认当前目录）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      execute: (args: { projectId: string; status?: string; cwd?: string }) =>
        executeTaskList(ctx, toolConfig, args),
      presentCall: args => presentCall('任务板列表', args),
    }),
  }

  for (const tool of Object.values(tools)) ctx.tools.register(tool)

  // Web 数据面：GET /state 快照 + POST /audit 审计 + POST /verify 校验
  // 运行时基于当前会话 cwd（面板快照读取项目产物）
  registerWebSurface(ctx, toolConfig, () => runtimeFromCtx(ctx, process.cwd()))

  // 数据库持久化：打开 agiteam 存储域（effect 卸载时关闭）
  ctx.effect(async () => {
    const { openAgiteamDomain } = await import('./business/store')
    const domain = await openAgiteamDomain(ctx)
    return () => { void domain.handle.close() }
  }, 'dsh-agiteam: storage domain')

  if (config.injectGuidance) {
    ctx.on('agent/pre-step', async (
      { agent, messages, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (guidanceAlreadyInjected(agent)) return decision
      signal.throwIfAborted()
      const guidance = createUserMessage({
        content: [{ type: 'text', text: TEAM_GUIDANCE }],
        source: { kind: 'plugin', plugin: PLUGIN_TAG, form: 'instructions' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      return { kind: 'enter', messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance) }
    })
  }
}

/**
 * 为 taskboard 所有项目 ensure 默认自动化规则（enabled，幂等）。
 *
 * 为什么必要：taskboard 的自动化执行（coordinator 扫描 todo → claim → 启动 agent）
 * 依赖 automation_rules 里有 enabled 规则。用户在 UI 创建/批准任务后，若无规则，
 * 任务永远卡在 todo（"批准执行没反应"）。本函数给每个缺规则的项目补一条默认规则：
 *  - agentPreset: 'code'（本机已装的通用工作 preset，含标准模式全部能力，
 *    能读 Obsidian/执行任务；taskboard 默认的 'standard' 本机未安装）
 *  - intervalMs: 15000（15 秒扫描一次 todo）
 *  - 已有规则的项目跳过（尊重用户自定义）
 *
 * 直接写 SQLite（provider 的 createAutomation 要求 human actor 且 state=paused，
 * 需要再 enable；SQL 一步到位且幂等）。
 */
async function ensureDefaultAutomationRules(): Promise<void> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = '/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard.sqlite'
    const db = new DatabaseSync(dbPath)
    const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>
    const now = Date.now()
    let added = 0
    for (const project of projects) {
      // 已有规则：若仍是旧版 'standard' preset（本机未安装），升级为 'code'
      const existing = db.prepare('SELECT id, config_json FROM automation_rules WHERE project_id = ?').all(project.id) as
        Array<{ id: string; config_json: string }>
      for (const rule of existing) {
        const cfg = JSON.parse(rule.config_json) as { agentPreset?: string }
        if (cfg.agentPreset === 'standard') {
          cfg.agentPreset = 'code'
          db.prepare('UPDATE automation_rules SET config_json = ?, version = version + 1, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(cfg), Date.now(), rule.id)
          console.error(`[dsh-agiteam] 规则 ${rule.id.slice(0, 20)} preset standard → code（本机无 standard）`)
        }
      }
      const hasRule = db.prepare('SELECT count(*) c FROM automation_rules WHERE project_id = ?').get(project.id) as { c: number }
      if ((hasRule?.c ?? 0) > 0) continue
      const config = JSON.stringify({
        intervalMs: 15_000,
        // 默认 preset 用 code：本机已装通用 preset（含全部标准能力）。
        // 不要用 'standard'——本机未安装该 preset，worker 启动会失败。
        agentPreset: 'code',
        concurrencyLimit: 1,
        quotaPolicy: 'ignore',
        autoPauseOnEmpty: false,
      })
      db.prepare(
        `INSERT INTO automation_rules(id, project_id, config_json, state, version, last_decision_json, next_eligible_at, created_at, updated_at)
         VALUES (?, ?, ?, 'enabled', 1, NULL, ?, ?, ?)`,
      ).run(`automation-default-${project.id}`, project.id, config, now, now, now)
      added += 1
    }
    db.close()
    if (added > 0) console.error(`[dsh-agiteam] 已为 ${added} 个项目补默认自动化规则（任务批准后自动执行）`)
  } catch (err) {
    // 规则 ensure 失败不阻断（用户可手动在 UI 配自动化）
    console.error(`[dsh-agiteam] 默认自动化规则 ensure 失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

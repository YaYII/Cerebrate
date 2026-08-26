/**
 * 工具契约注册表——wiki_* 工具集的单一真源。
 *
 * 这些契约描述 AI 主导的工具面。内容从不在此生成：AI 浏览（wiki_tree、wiki_read）、
 * 撰写并落盘页面（wiki_write），或把完整构建提交给 DSH 子代理（wiki_build），
 * 以及同步状态检查（wiki_status）与增量进化（wiki_evolve）。
 *
 * 契约与实现分离：注册（index.ts）与文档共享同一份契约数据，永不漂移。
 *
 * @module @deepseek-ai/dsh-project-wiki
 */

/** 一个工具的入参说明。 */
export interface ParamSpec {
  name: string
  type: string
  required?: boolean
  default?: string
  description: string
}

/** 一个工具的出参说明。 */
export interface OutputSpec {
  field: string
  type: string
  description: string
}

/** 一个 wiki_* 工具的完整契约。 */
export interface ToolContract {
  id: string
  name: string
  summary: string
  description: string
  inputs: ParamSpec[]
  outputs: OutputSpec[]
  example: string
  whenToUse: string
}

/** 契约注册表——每个工具一个声明块，注册与文档共享单一真源。 */
export const TOOL_CONTRACTS: ToolContract[] = [
  // wiki_tree：AI 认识项目的第一步——看真实目录树，识别模块边界。
  {
    id: 'wiki_tree',
    name: '浏览项目目录树',
    summary: '列出项目的真实目录结构（含 top-level 摘要），供 AI 识别模块边界。',
    description: '纯 IO：返回项目目录树与顶层条目。不解析、不推断——由 AI 判断 backend/ frontend/ docker/ database/ 等真实模块，并规划知识库结构。自动跳过 node_modules/.git/dist 等构建产物。',
    inputs: [
      { name: 'project', type: 'string', required: false, default: '当前工作目录', description: '项目目录（绝对或相对路径）' },
    ],
    outputs: [
      { field: 'root', type: 'string', description: '项目根目录绝对路径' },
      { field: 'tree', type: 'object', description: '目录树（dir 节点含 children；文件含 bytes）' },
      { field: 'top', type: 'array', description: '顶层条目（模块边界快照）' },
    ],
    example: 'wiki_tree project=/path/to/project',
    whenToUse: '构建知识库第一步：先看真实目录，识别模块边界。',
  },
  // wiki_read：有界读取文件内容，供 AI 通读理解架构——不解析、不摘要。
  {
    id: 'wiki_read',
    name: '读项目文件',
    summary: '读取任意项目文件的文本内容（有界），供 AI 通读理解架构与业务。',
    description: '纯 IO：按相对路径读取文件（默认 96KB 上限、首 40000 字符），返回 found/content/truncated。不解析、不摘要——内容理解属于 AI。',
    inputs: [
      { name: 'project', type: 'string', required: false, default: '当前工作目录', description: '项目目录' },
      { name: 'path', type: 'string', required: true, description: '相对路径（如 backend/pom.xml、docker-compose.yml）' },
    ],
    outputs: [
      { field: 'found', type: 'boolean', description: '文件是否存在' },
      { field: 'content', type: 'string', description: '文件内容（有界截断）' },
      { field: 'truncated', type: 'boolean', description: '是否截断' },
    ],
    example: 'wiki_read project=/path path=backend/pom.xml',
    whenToUse: '通读 README/依赖清单/入口/配置，理解模块职责与业务链路。',
  },
  // wiki_write：AI 之手伸进 vault——frontmatter 戳记 + Mermaid 清洗 + 证据校验 + git 提交。
  {
    id: 'wiki_write',
    name: '写入知识库页面',
    summary: '把 AI 撰写的页面落地到 Obsidian vault（frontmatter + 默认 git 提交）。',
    description: 'AI 产出 Markdown（含 Mermaid 与证据引用）；本工具做落盘：frontmatter 戳记（author/generator/updated/tags）、幂等写入（保留首代 created）、写入前自动清洗 Mermaid 语法风险并校验证据引用存在性、vault git 提交（时间戳消息）。不做内容生成。',
    inputs: [
      { name: 'project', type: 'string', required: true, description: '知识库项目名（vault 目录名）' },
      { name: 'path', type: 'string', required: true, description: 'vault 相对路径（如 02-后端/订单服务.md；自动防路径穿越）' },
      { name: 'body', type: 'string', required: true, description: '页面 Markdown 正文（H1 开头，可含 Mermaid）' },
      { name: 'source', type: 'string', required: false, default: '', description: '源码目录（用于 git_head 戳记，默认当前工作目录）' },
      { name: 'commit', type: 'boolean', required: false, default: 'true', description: '是否 git 提交' },
    ],
    outputs: [
      { field: 'path / written / changed', type: 'string|boolean', description: '写入路径 / 是否新写 / 是否覆盖' },
      { field: 'committed / vaultHead', type: 'boolean|string', description: '提交状态 / vault HEAD' },
      { field: 'warnings', type: 'array', description: '校验警告（Mermaid 风险、证据缺失等）' },
      { field: 'dir', type: 'string', description: '知识库目录' },
    ],
    example: 'wiki_write project=my-app path=02-后端/订单服务.md body=正文',
    whenToUse: 'AI 写好一页后立即落盘；逐页增量提交。',
  },
  // wiki_build：完整构建委托给 DSH 子代理（AI 自行完成全流程）——插件只编排。
  {
    id: 'wiki_build',
    name: 'AI 主导构建知识库',
    summary: '提交完整知识库构建任务给 DSH 子代理（AI 自行完成全部流程）。',
    description: '向 DSH 提交一个子代理任务：它用 wiki_tree/read 认识项目（识别真实模块、业务链路、技术栈），自主规划知识库结构（每模块独立知识区域），逐页撰写（Mermaid + 证据引用），并用 wiki_write 落盘 + git 提交。插件只做编排——内容完全由 AI 生成。',
    inputs: [
      { name: 'project', type: 'string', required: true, description: '项目目录' },
      { name: 'commit', type: 'boolean', required: false, default: 'true', description: '写入时是否 git 提交' },
    ],
    outputs: [
      { field: 'project', type: 'string', description: '项目名' },
      { field: 'report', type: 'string', description: '子代理的完成总结（结构/页数/覆盖模块）' },
      { field: 'dir', type: 'string', description: '知识库根目录' },
    ],
    example: 'wiki_build project=/path/to/project',
    whenToUse: '一键让 AI 通读项目并构建完整知识库；或作为团队成员入口。',
  },
  // wiki_status：只读判变（git head + 文件摘要）——快速判断是否需要增量刷新。
  {
    id: 'wiki_status',
    name: '知识库同步状态',
    summary: '检查项目代码与知识库快照是否同步（git head + 文件 digest 判变）。',
    description: '扫描项目并对比 .wiki-meta.json 快照：返回 synced、变化原因、受影响的模块、新增/修改/删除文件清单。纯 IO 判变，不调用 AI——快速判断是否需要 wiki_evolve。',
    inputs: [
      { name: 'project', type: 'string', required: false, default: '当前工作目录', description: '项目目录' },
    ],
    outputs: [
      { field: 'synced', type: 'boolean', description: '知识库是否与代码同步' },
      { field: 'reason', type: 'string', description: '判变结论（变化原因或无变化）' },
      { field: 'affectedModules / newOrModified / deleted', type: 'array', description: '受影响模块 / 变更文件清单' },
      { field: 'hasSnapshot / lastScannedAt', type: 'boolean|string', description: '快照状态' },
    ],
    example: 'wiki_status project=/path/to/project',
    whenToUse: '代码变更后例行检查；确认是否需要 wiki_evolve。',
  },
  // wiki_evolve：代码变化后只刷新受影响页面——增量，不重建整个知识库。
  {
    id: 'wiki_evolve',
    name: '知识库增量进化',
    summary: '代码变化后，让 AI 只刷新受影响的页面（增量，不重建整个知识库）。',
    description: '扫描项目 → 对比快照（git head + 每文件 sha256 digest）→ 有变化时提交 DSH 子代理任务：任务文本携带变化清单（新增/修改/删除文件 + 受影响模块），AI 用 wiki_tree/read 查看变化文件、用 wiki_write 只更新对应页面。完成后刷新快照。无变化时零开销返回。',
    inputs: [
      { name: 'project', type: 'string', required: false, default: '当前工作目录', description: '项目目录' },
      { name: 'commit', type: 'boolean', required: false, default: 'true', description: '是否 git 提交' },
    ],
    outputs: [
      { field: 'changed', type: 'boolean', description: '是否发生了刷新' },
      { field: 'reason', type: 'string', description: '判变结论' },
      { field: 'report', type: 'string', description: '子代理完成总结（更新了哪些页面）' },
      { field: 'affectedModules', type: 'array', description: '受影响的模块' },
    ],
    example: 'wiki_evolve project=/path/to/project',
    whenToUse: '代码提交后例行调用；wiki_status 显示 synced=false 时。',
  },
]

/** 按 id 查一个契约。 */
export function contractOf(id: string): ToolContract | undefined {
  return TOOL_CONTRACTS.find(c => c.id === id)
}

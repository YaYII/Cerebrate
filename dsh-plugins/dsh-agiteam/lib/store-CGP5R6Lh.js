import { a as boolean, c as number, d as string, f as union, i as array, l as object, n as domainTable, r as _enum, t as defineDomain, u as record } from "./lib-Bj8I1VnZ.js";
//#region src/business/domain.ts
/**
* dsh-agiteam 存储域 —— 基于官方 storageDomain（JSON 后端）的数据库持久化。
*
* 为什么用 storageDomain 而非文件系统：pipeline-kernel 同款官方机制，
* 数据可靠落盘、可查询、可追溯（替代 .teamdev/ 的散落 JSON 文件）。
*
* 表结构：
*  projects  (key=projectId)  项目状态（阶段/评审意见/产物映射/追溯实体汇总）
*  entities  (key=实体id)     追溯实体（需求/功能/用例/单测/代码/脚本）
*  audit     (key=seq)        审计日志（链式哈希防篡改）
*  tasks     (key=taskId)     阶段任务（执行角色/状态/结果）
*/
/** 项目状态记录（projects 表行）。 */
const ProjectRecord = object({
	id: string(),
	name: string(),
	rawRequirement: string().default(""),
	stage: string().default("requirement"),
	completed: record(string(), boolean()).default({}),
	reviewComments: record(string(), array(string())).default({}),
	artifacts: record(string(), string()).default({}),
	cwd: string().default(""),
	/** 自动驱动标志：true = 阶段完成自动推进。 */
	autoDrive: boolean().default(true),
	/** 当前处理中的需求 id（需求×阶段专属会话）。 */
	currentReqId: string().default(""),
	/** 项目内需求列表（reqId → 标题）。 */
	requirements: record(string(), string()).default({}),
	/** 发起项目的主会话 id（角色完成时通知该会话继续指挥）。 */
	ownerSession: string().default(""),
	/** 知识库相对路径（团队知识库/<项目>/<需求大类>/<具体需求>/），用于 Obsidian 落盘。 */
	kbPath: string().default(""),
	/** 主会话 provider（角色 agent 继承，避免"无 provider/model"启动失败）。 */
	ownerProvider: string().default(""),
	/** 主会话 model。 */
	ownerModel: string().default(""),
	/** 主会话 reasoning effort。 */
	ownerEffort: string().default(""),
	createdAt: number(),
	updatedAt: number()
});
/** 追溯实体记录（entities 表行，key = `${projectId}:${type}:${id}`）。 */
const EntityRecord = object({
	/** 实体 id（R-1/F-1/TC-1/UT-1/CF-1/AS-1）。 */
	id: string(),
	/** 实体类型：requirement/feature/testcase/unittest/codefile/script。 */
	type: _enum([
		"requirement",
		"feature",
		"testcase",
		"unittest",
		"codefile",
		"script"
	]),
	/** 关联项目 id。 */
	projectId: string(),
	/** 实体数据（JSON 字符串）。 */
	data: string(),
	/** 关联关系（如 feature → requirementIds，testcase → featureId）。 */
	refs: record(string(), union([string(), array(string())])).default({}),
	/** 状态（passed/pending/failed）。 */
	status: _enum([
		"passed",
		"pending",
		"failed"
	]).default("pending"),
	/** 登记时间。 */
	createdAt: number(),
	/** 更新时间。 */
	updatedAt: number()
});
/** 审计日志记录（audit 表行，key = `${projectId}:${seq}`）。 */
const AuditRecord = object({
	seq: number(),
	projectId: string(),
	time: number(),
	action: string(),
	role: string(),
	stage: string().default(""),
	detail: string().default(""),
	fingerprint: string().optional(),
	/** 链式哈希防篡改。 */
	prevHash: string(),
	hash: string()
});
/** 阶段任务记录（tasks 表行，key = `${projectId}:${taskId}`）。 */
const TaskRecord = object({
	id: string(),
	projectId: string(),
	stage: string(),
	title: string(),
	/** 执行角色。 */
	role: string(),
	/** 任务状态（任务板七状态机）。 */
	status: _enum([
		"open",
		"claimed",
		"in_progress",
		"in_review",
		"paused",
		"done",
		"failed",
		"rejected"
	]).default("open"),
	/** 执行会话 id（随机唯一，taskboard 模式；重启后可 resume 续接）。 */
	sessionId: string().default(""),
	/** 认领者（会话 id，兼容旧字段）。 */
	claimedBy: string().optional(),
	/** 完成结果。 */
	result: string().default(""),
	/** 审批建议（AI 代审批时提交，人工可采纳/驳回）。 */
	approvalSuggestion: string().default(""),
	/** 审批来源：human（人工批准）/ ai（AI 代为审批）/ auto（自动放行）。 */
	approvalSource: _enum([
		"human",
		"ai",
		"auto"
	]).default("human"),
	/** 审批时间。 */
	approvedAt: number().optional(),
	/** 审批意见（打回/暂停原因）。 */
	reviewComment: string().default(""),
	/** 是否人工暂停（随时可暂停任务）。 */
	pausedByHuman: boolean().default(false),
	/** 暂停原因。 */
	pauseReason: string().default(""),
	/** 创建时间。 */
	createdAt: number(),
	/** 更新时间。 */
	updatedAt: number()
});
/** agiteam 存储域定义（tables + version）。 */
const agiteamDomain = defineDomain({
	name: "agiteam",
	version: 1,
	tables: {
		projects: domainTable(ProjectRecord),
		entities: domainTable(EntityRecord),
		audit: domainTable(AuditRecord),
		tasks: domainTable(TaskRecord)
	}
});
/** 从域表构造复合 key。 */
function entityKey(projectId, type, id) {
	return `${projectId}:${type}:${id}`;
}
function auditKey(projectId, seq) {
	return `${projectId}:${seq}`;
}
function taskKey(projectId, taskId) {
	return `${projectId}:${taskId}`;
}
//#endregion
//#region src/business/store.ts
/**
* 打开 agiteam 存储域（幂等：已打开则复用）。
* @param ctx 插件上下文
* @returns 域句柄（调用方负责在 effect 中关闭）
*/
async function openAgiteamDomain(ctx) {
	const storageDomain = ctx.get("storageDomain");
	if (!storageDomain) throw new Error("storageDomain 服务不可用（需要 host 提供）");
	const existing = storageDomain.get("agiteam");
	if (existing) return {
		handle: existing,
		projects: existing.table("projects"),
		entities: existing.table("entities"),
		audit: existing.table("audit"),
		tasks: existing.table("tasks")
	};
	const handle = await storageDomain.open(agiteamDomain);
	return {
		handle,
		projects: handle.table("projects"),
		entities: handle.table("entities"),
		audit: handle.table("audit"),
		tasks: handle.table("tasks")
	};
}
/** 创建/更新项目。 */
async function upsertProject(domain, record) {
	await domain.projects.put(record.id, record);
}
/** 读取项目；不存在返回 undefined。 */
function getProject(domain, projectId) {
	return domain.projects.get(projectId);
}
/** 列出全部项目。 */
function listProjects(domain) {
	return [...domain.projects.entries()].map(([, v]) => v);
}
/** 登记/更新追溯实体。 */
async function upsertEntity(domain, record) {
	await domain.entities.put(entityKey(record.projectId, record.type, record.id), record);
}
/** 列出项目全部实体（按类型过滤可选）。 */
function listEntities(domain, projectId, type) {
	return [...domain.entities.entries()].filter(([k, v]) => k.startsWith(`${projectId}:`) && (type === void 0 || v.type === type)).map(([, v]) => v);
}
/** 追加审计记录（链式哈希）。返回完整记录。 */
async function appendAuditRecord(domain, record) {
	await domain.audit.put(auditKey(record.projectId, record.seq), record);
	return record;
}
/** 读取项目最近 N 条审计（按 seq 排序）。 */
function listAudit(domain, projectId, limit = 200) {
	return [...domain.audit.entries()].filter(([k]) => k.startsWith(`${projectId}:`)).map(([, v]) => v).sort((a, b) => a.seq - b.seq).slice(-limit);
}
/** 读取审计链末条（用于计算 prevHash）。 */
function lastAudit(domain, projectId) {
	const all = [...domain.audit.entries()].filter(([k]) => k.startsWith(`${projectId}:`)).map(([, v]) => v).sort((a, b) => a.seq - b.seq);
	return all.length > 0 ? all[all.length - 1] : void 0;
}
/** 创建/更新阶段任务。 */
async function upsertTask(domain, record) {
	await domain.tasks.put(taskKey(record.projectId, record.id), record);
}
/** 读取项目任务（按状态过滤可选）。 */
function listTasks(domain, projectId, status) {
	return [...domain.tasks.entries()].filter(([k, v]) => k.startsWith(`${projectId}:`) && (status === void 0 || v.status === status)).map(([, v]) => v).sort((a, b) => a.createdAt - b.createdAt);
}
/** 读取项目当前阶段任务（open/claimed）。 */
function openTasks(domain, projectId) {
	return listTasks(domain, projectId).filter((t) => t.status === "open" || t.status === "claimed");
}
//#endregion
export { appendAuditRecord, getProject, lastAudit, listAudit, listEntities, listProjects, listTasks, openAgiteamDomain, openTasks, upsertEntity, upsertProject, upsertTask };

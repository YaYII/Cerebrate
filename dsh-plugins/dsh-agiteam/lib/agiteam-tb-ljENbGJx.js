import { a as encodeAgiteamSource, i as agiteamSourceOf, n as AGITEAM_STAGE_NAMES, o as openTaskboardDatabase, r as AGITEAM_STAGE_ROLE, s as stageLabel, t as AGITEAM_NEXT_STAGE } from "./taskboard-bridge-D3dMqFx9.js";
//#region src/business/agiteam-tb.ts
/** taskboard 数据库路径（与 profile 的 cordis.patch.yml 一致）。 */
const TB_DB_PATH = "/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard.sqlite";
/** 打开的 provider 句柄（进程级缓存，幂等）。 */
let provider;
/** 获取（或打开）taskboard provider。 */
function tbProvider() {
	if (!provider) provider = openTaskboardDatabase(TB_DB_PATH, { allowSharedWorktrees: false });
	return provider;
}
/** actor 辅助。 */
const humanActor = () => ({
	kind: "human",
	actorId: "human:owner"
});
const agentActor = (sessionId) => ({
	kind: "agent",
	actorId: sessionId,
	sessionId,
	agentId: sessionId
});
/** 项目 key 安全化（taskboard 要求：2-10 个大写字母/数字，以字母开头，唯一）。 */
function tbProjectKey(projectId) {
	let hash = 0;
	for (let i = 0; i < projectId.length; i++) hash = (hash << 5) - hash + projectId.charCodeAt(i) | 0;
	return `AGI${(hash >>> 0).toString(36).toUpperCase()}`.slice(0, 10);
}
/** 项目是否已存在于 taskboard。 */
function tbProjectExists(projectId) {
	const p = tbProvider();
	try {
		return p.getProject(tbProjectKey(projectId)) !== void 0;
	} catch {
		return false;
	}
}
/** 创建 AGI 团队项目（taskboard project）。返回 project 记录。 */
function tbCreateProject(projectId, projectName, workspaceId) {
	const p = tbProvider();
	const existing = p.getProject(tbProjectKey(projectId));
	if (existing) return existing;
	return p.createProject({
		key: tbProjectKey(projectId),
		name: projectName,
		...workspaceId === void 0 ? {} : { workspaceId },
		labels: ["agiteam"]
	}, humanActor());
}
/** 创建阶段任务（todo 状态，source 承载 AGI 阶段信息）。返回任务记录。 */
function tbCreateStageTask(projectId, stage, title, description, info) {
	const p = tbProvider();
	const project = p.getProject(tbProjectKey(projectId));
	if (!project) throw new Error(`taskboard 项目 ${projectId} 不存在`);
	return p.createTask({
		projectId: project.id,
		title,
		description,
		creator: "agiteam:owner",
		status: "todo",
		labels: ["agiteam", stageLabel(stage)],
		source: encodeAgiteamSource({
			stage,
			...info.requirementId === void 0 ? {} : { requirementId: info.requirementId },
			...info.role === void 0 ? {} : { role: info.role },
			...info.artifactPath === void 0 ? {} : { artifactPath: info.artifactPath },
			...info.cwd === void 0 ? {} : { cwd: info.cwd },
			...info.kbPath === void 0 ? {} : { kbPath: info.kbPath }
		})
	}, humanActor());
}
/** 列出项目的 AGI 阶段任务（按标签过滤）。 */
function tbListStageTasks(projectId) {
	const p = tbProvider();
	const project = p.getProject(tbProjectKey(projectId));
	if (!project) return [];
	return p.listTasks({
		projectId: project.id,
		includeArchived: false
	}).filter((task) => task.labels.includes("agiteam"));
}
/** 查项目当前阶段任务（todo/in_progress/in_review，取最新）。 */
function tbCurrentStageTask(projectId) {
	return tbListStageTasks(projectId).filter((t) => [
		"todo",
		"in_progress",
		"in_review"
	].includes(t.status)).sort((a, b) => b.createdAt - a.createdAt)[0];
}
/** 读取任务 source 里的 AGI 阶段信息。 */
function tbStageOf(task) {
	return agiteamSourceOf(task.source)?.stage;
}
/** 阶段任务提交审批（in_review）。由认领该任务的 agent 提交（taskboard 语义：human 不能 submitReview）。 */
function tbSubmitStageReview(taskId, expectedVersion, verification, resultComment, sessionId) {
	const p = tbProvider();
	let actor;
	if (sessionId) actor = agentActor(sessionId);
	else try {
		const claimSession = p.getTaskDetail(taskId, { activityLimit: 0 }).activeClaim?.sessionId;
		if (!claimSession) throw new Error("任务无 active claim");
		actor = agentActor(claimSession);
	} catch {
		throw new Error(`任务 ${taskId} 无认领者，无法提交审批（需先由角色 agent 认领）`);
	}
	return p.submitReview(taskId, expectedVersion, verification, resultComment, actor);
}
/** 人工审批放行（in_review → done，human-only accept）。 */
function tbApproveStage(taskId, expectedVersion, comment) {
	const p = tbProvider();
	const task = p.accept(taskId, expectedVersion, humanActor());
	if (comment) try {
		p.comment(taskId, task.version, comment, humanActor());
	} catch {}
	return task;
}
/** 人工打回（in_review → todo，带意见返工）。 */
function tbRejectStage(taskId, expectedVersion, comment) {
	return tbProvider().returnForRework(taskId, expectedVersion, "todo", comment, humanActor());
}
/** 人工暂停（blocked）。 */
function tbPauseStage(taskId, expectedVersion, reason) {
	return tbProvider().block(taskId, expectedVersion, reason, humanActor());
}
/** 恢复（blocked → todo 重新可认领）。 */
function tbResumeStage(taskId, expectedVersion) {
	return tbProvider().resume(taskId, expectedVersion, humanActor(), "todo");
}
/** 给阶段任务加依赖关系（blocks：前置阶段完成后当前才能认领）。 */
function tbAddDependency(sourceTaskId, sourceVersion, targetTaskId) {
	const p = tbProvider();
	try {
		p.addRelation(sourceTaskId, sourceVersion, targetTaskId, "blocks", humanActor());
	} catch {}
}
/** 阶段 → 阶段任务标题。 */
function stageTaskTitle(stage, projectName) {
	return `${AGITEAM_STAGE_NAMES[stage] ?? stage}（${AGITEAM_STAGE_ROLE[stage] ?? "团队"}）· ${projectName}`;
}
/** 当前阶段 → 下一阶段（无则 undefined=交付）。 */
function nextStageOf(stage) {
	return AGITEAM_NEXT_STAGE[stage];
}
/** 项目当前阶段（取最新未 done 任务的 stage；无任务返回 requirement）。 */
function tbProjectStage(projectId) {
	const active = tbListStageTasks(projectId).filter((t) => t.status !== "done" && t.status !== "canceled").sort((a, b) => b.createdAt - a.createdAt)[0];
	return active ? tbStageOf(active) ?? "requirement" : "requirement";
}
//#endregion
export { nextStageOf, stageTaskTitle, tbAddDependency, tbApproveStage, tbCreateProject, tbCreateStageTask, tbCurrentStageTask, tbListStageTasks, tbPauseStage, tbProjectExists, tbProjectKey, tbProjectStage, tbProvider, tbRejectStage, tbResumeStage, tbStageOf, tbSubmitStageReview };

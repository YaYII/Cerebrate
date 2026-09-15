import { createRequire } from "node:module";
//#region src/business/taskboard-bridge.ts
/**
* taskboard 底座衔接层 —— dsh-agiteam（AGI 团队大脑）与 taskboard（成熟底座）的桥梁。
*
* 为什么用 createRequire 动态加载：
*  dsh-agiteam 独立构建（ESM），运行时从 profile 的 node_modules 解析
*  `@shengsheng/dsh-taskboard`（v0.1.4，Apache-2.0）。Node 模块解析
*  从 dsh-agiteam 真实路径向上找不到该包，必须用 createRequire 锚定
*  profile 的 package.json 来解析。这样：
*   1. 不复制 taskboard 源码（避免依赖坑/tsconfig 冲突）；
*   2. taskboard 的成熟 UI（SQLite 权威 + 乐观锁 + change-watch）原样可用；
*   3. 我们只在它的领域层之上叠加 AGI 团队流程。
*
* 核心能力（taskboard provider 的 93 个方法，这里收口为 AGI 层需要的窄接口）：
*  - createProject / createTask：AGI 团队项目与阶段任务
*  - claim / submitReview / approve / moveStatus：任务板状态机 + 人工审批
*  - source 字段：承载 AGI 阶段（stage/requirement/role/artifactPath）
*/
/** profile 的 package.json 绝对路径（taskboard 安装于此）。 */
const PROFILE_PKG = "/home/as-workstation01/.dsh/profiles/web/package.json";
/** 惰性加载 taskboard 模块（首次调用时解析，缓存句柄）。 */
let cached;
/** 从 profile 解析 taskboard 包（首次调用缓存）。 */
function loadTaskboard() {
	if (cached) return cached;
	const requireFromProfile = createRequire(PROFILE_PKG);
	const domain = requireFromProfile("@shengsheng/dsh-taskboard/domain");
	const root = requireFromProfile("@shengsheng/dsh-taskboard");
	const api = {
		SqliteTaskboardProvider: root.SqliteTaskboardProvider,
		ProjectId: domain.ProjectId,
		TaskId: domain.TaskId,
		TaskboardError: domain.TaskboardError,
		TASK_STATUSES: domain.TASK_STATUSES,
		requireHuman: domain.requireHuman,
		isHumanOnlyOperation: domain.isHumanOnlyOperation,
		parseTaskStatus: domain.parseTaskStatus,
		TaskboardAutomationCoordinator: root.TaskboardAutomationCoordinator,
		HarnessTaskboardWorker: root.HarnessTaskboardWorker
	};
	cached = api;
	return api;
}
/** 打开（或复用）taskboard SQLite 数据库。 */
function openTaskboardDatabase(path, options) {
	return new (loadTaskboard()).SqliteTaskboardProvider(path, options);
}
/** 从任务 source 解码 AGI 阶段信息（无则 undefined）。 */
function agiteamSourceOf(source) {
	if (!source || typeof source.agiteamStage !== "string") return void 0;
	const out = { stage: source.agiteamStage };
	if (typeof source.agiteamRequirementId === "string") out.requirementId = source.agiteamRequirementId;
	if (typeof source.agiteamRole === "string") out.role = source.agiteamRole;
	if (typeof source.agiteamArtifactPath === "string") out.artifactPath = source.agiteamArtifactPath;
	if (typeof source.agiteamCwd === "string") out.cwd = source.agiteamCwd;
	if (typeof source.agiteamKbPath === "string") out.kbPath = source.agiteamKbPath;
	return out;
}
/** 编码 AGI 阶段信息进 source（供 createTask 用）。 */
function encodeAgiteamSource(info) {
	return {
		agiteamStage: info.stage,
		...info.requirementId === void 0 ? {} : { agiteamRequirementId: info.requirementId },
		...info.role === void 0 ? {} : { agiteamRole: info.role },
		...info.artifactPath === void 0 ? {} : { agiteamArtifactPath: info.artifactPath },
		...info.cwd === void 0 ? {} : { agiteamCwd: info.cwd },
		...info.kbPath === void 0 ? {} : { agiteamKbPath: info.kbPath }
	};
}
/** 阶段 → taskboard 标签（UI 列筛选用）。 */
function stageLabel(stage) {
	return `stage:${stage}`;
}
/** 阶段名 → 中文（供 UI 展示）。 */
const AGITEAM_STAGE_NAMES = {
	requirement: "需求分析",
	"req-review": "需求评审",
	product: "产品设计",
	"product-review": "产品评审",
	testcase: "测试用例设计",
	"testcase-review": "测试用例评审",
	develop: "正式开发",
	"feature-accept": "逐功能验收",
	"e2e-accept": "端到端验收",
	done: "交付"
};
/** 阶段 → 角色（与 roles.ts 一致，避免循环依赖）。 */
const AGITEAM_STAGE_ROLE = {
	requirement: "requirement",
	"req-review": "req-reviewer",
	product: "product",
	"product-review": "prod-reviewer",
	testcase: "test-designer",
	"testcase-review": "test-designer",
	develop: "developer",
	"feature-accept": "tester",
	"e2e-accept": "tester"
};
/** 正常顺序的下一阶段。 */
const AGITEAM_NEXT_STAGE = {
	requirement: "req-review",
	"req-review": "product",
	product: "product-review",
	"product-review": "testcase",
	testcase: "testcase-review",
	"testcase-review": "develop",
	develop: "feature-accept",
	"feature-accept": "e2e-accept",
	"e2e-accept": "done",
	done: void 0
};
//#endregion
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
/** 项目 key 安全化（taskboard 要求：2-10 个大写字母/数字，以字母开头）。 */
function tbProjectKey(projectId) {
	const padded = (projectId.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "PROJECT") + "PROJECT";
	return (/^[A-Z]/.test(padded) ? padded : `A${padded}`).slice(0, 10);
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
export { encodeAgiteamSource as a, stageLabel as c, agiteamSourceOf as i, AGITEAM_STAGE_NAMES as n, nextStageOf, loadTaskboard as o, AGITEAM_STAGE_ROLE as r, openTaskboardDatabase as s, stageTaskTitle, AGITEAM_NEXT_STAGE as t, tbApproveStage, tbCreateProject, tbCreateStageTask, tbCurrentStageTask, tbListStageTasks, tbPauseStage, tbProjectExists, tbProjectKey, tbProjectStage, tbProvider, tbRejectStage, tbResumeStage, tbStageOf, tbSubmitStageReview };

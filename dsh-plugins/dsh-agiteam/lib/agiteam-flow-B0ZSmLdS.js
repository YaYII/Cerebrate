import { nextStageOf, stageTaskTitle, tbApproveStage, tbCreateProject, tbCreateStageTask, tbCurrentStageTask, tbListStageTasks, tbPauseStage, tbProjectStage, tbProvider, tbRejectStage, tbResumeStage, tbStageOf } from "./agiteam-tb-DmI91I58.js";
//#region src/business/agiteam-flow.ts
/** 阶段 → 角色 preset id（与 roles.ts 一致）。 */
const STAGE_PRESET = {
	requirement: "agiteam-requirement",
	"req-review": "agiteam-req-reviewer",
	product: "agiteam-product",
	"product-review": "agiteam-prod-reviewer",
	testcase: "agiteam-test-designer",
	"testcase-review": "agiteam-test-designer",
	develop: "agiteam-developer",
	"feature-accept": "agiteam-tester",
	"e2e-accept": "agiteam-tester"
};
/** 阶段 → 产物文件名（供引导消息）。 */
const STAGE_ARTIFACT_FILE = {
	requirement: "requirements/requirements.md",
	"req-review": "requirements/requirements.md",
	product: "features/features.md",
	"product-review": "features/features.md",
	testcase: "testcases/testcases.md",
	"testcase-review": "testcases/testcases.md",
	develop: "code/",
	"feature-accept": "acceptance.md",
	"e2e-accept": "e2e.md"
};
/** 从 Cordis ctx 拿 TaskboardService（taskboard 插件注册的服务）。 */
function tbService(ctx) {
	const service = ctx.get("taskboard");
	if (!service) throw new Error("taskboard 服务不可用（确认 @shengsheng/dsh-taskboard 已在 bundle 注册且先于 agiteam 加载）");
	return service;
}
/** 启动角色 agent 执行阶段任务（HarnessTaskboardWorker.start）。 */
async function launchStageAgent(ctx, projectId, taskId, projectName, stage, requirement, modelRoute) {
	const service = tbService(ctx);
	const provider = tbProvider();
	const { loadTaskboard } = await import("./taskboard-bridge-D3dMqFx9.js").then((n) => n.c);
	const api = loadTaskboard();
	const presetId = STAGE_PRESET[stage] ?? "agiteam-requirement";
	const rule = {
		id: `agiteam-${projectId}-${stage}`,
		projectId: provider.getProject((await import("./agiteam-tb-DmI91I58.js")).tbProjectKey(projectId)).id,
		config: {
			intervalMs: 3e4,
			agentPreset: presetId,
			...modelRoute ? { modelRoute } : {},
			concurrencyLimit: 1,
			quotaPolicy: "ignore",
			autoPauseOnEmpty: true
		},
		state: "enabled",
		version: 1,
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	const task = provider.getTask(taskId);
	await new api.HarnessTaskboardWorker(ctx, service).start(rule, task);
}
/** AGI 项目启动：创建项目 + 第一阶段任务 + 启动需求分析师。 */
async function agiteamStartFlow(ctx, projectId, projectName, requirement, workspaceId, kbPath) {
	if (!ctx.get("taskboard")) throw new Error("taskboard 服务不可用（未注册或未先加载）");
	const project = tbCreateProject(projectId, projectName, workspaceId);
	const task = tbCreateStageTask(projectId, "requirement", stageTaskTitle("requirement", projectName), requirement, {
		role: "requirement",
		...STAGE_ARTIFACT_FILE.requirement ? { artifactPath: STAGE_ARTIFACT_FILE.requirement } : {},
		...kbPath ? { kbPath } : {}
	});
	await launchStageAgent(ctx, projectId, task.id, projectName, "requirement", requirement);
	return {
		project: {
			key: project.key,
			id: project.id
		},
		task: {
			id: task.id,
			identifier: task.identifier
		},
		stage: "requirement"
	};
}
/** 人工审批放行（agiteam_approve）：in_review → done，创建下阶段任务并唤醒下角色。 */
async function agiteamApproveFlow(ctx, projectId, taskId, expectedVersion, projectName, comment, kbPath) {
	const approved = tbApproveStage(taskId, expectedVersion, comment);
	const next = nextStageOf(tbStageOf(approved) ?? tbProjectStage(projectId));
	if (!next || next === "done") return { approved: {
		id: approved.id,
		status: approved.status,
		title: approved.title
	} };
	const role = STAGE_PRESET[next]?.replace("agiteam-", "");
	const nextTask = tbCreateStageTask(projectId, next, stageTaskTitle(next, projectName), "", {
		...role ? { role } : {},
		...STAGE_ARTIFACT_FILE[next] ? { artifactPath: STAGE_ARTIFACT_FILE[next] } : {},
		...kbPath ? { kbPath } : {}
	});
	await launchStageAgent(ctx, projectId, nextTask.id, projectName, next);
	return {
		approved: {
			id: approved.id,
			status: approved.status,
			title: approved.title
		},
		nextTask: {
			id: nextTask.id,
			identifier: nextTask.identifier
		},
		nextStage: next
	};
}
/** 人工打回（agiteam_reject）：in_review → todo 返工（带意见）。 */
function agiteamRejectFlow(projectId, taskId, expectedVersion, comment) {
	const rejected = tbRejectStage(taskId, expectedVersion, comment);
	return {
		id: rejected.id,
		status: rejected.status,
		title: rejected.title
	};
}
/** 人工暂停（agiteam_pause）。 */
function agiteamPauseFlow(projectId, taskId, expectedVersion, reason) {
	const paused = tbPauseStage(taskId, expectedVersion, reason);
	return {
		id: paused.id,
		status: paused.status,
		title: paused.title
	};
}
/** 恢复（agiteam_resume）。 */
function agiteamResumeFlow(projectId, taskId, expectedVersion) {
	const resumed = tbResumeStage(taskId, expectedVersion);
	return {
		id: resumed.id,
		status: resumed.status,
		title: resumed.title
	};
}
/** 项目全景（供 agiteam_status 与 UI）。 */
function agiteamProjectView(projectId) {
	const tasks = tbListStageTasks(projectId);
	const current = tbCurrentStageTask(projectId);
	return {
		projectId,
		stage: tbProjectStage(projectId),
		currentTask: current ? {
			id: current.id,
			title: current.title,
			status: current.status,
			stage: tbStageOf(current),
			version: current.version
		} : void 0,
		tasks: tasks.map((t) => ({
			id: t.id,
			identifier: t.identifier,
			title: t.title,
			status: t.status,
			stage: tbStageOf(t),
			version: t.version,
			createdAt: t.createdAt
		}))
	};
}
//#endregion
export { agiteamApproveFlow, agiteamPauseFlow, agiteamProjectView, agiteamRejectFlow, agiteamResumeFlow, agiteamStartFlow };

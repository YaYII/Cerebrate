import { a as createUserMessage, r as STAGE_ROLE, t as ROLE_NAMES } from "./roles-D9nobWnx.js";
import { i as reviewBackTo, n as isReviewStage, r as nextStage, t as STAGE_NAMES } from "./stage-6kxWDxZR.js";
import { n as makeAuditEntry } from "./audit-CJNju73G.js";
import { appendAuditRecord, getProject, lastAudit, listTasks, openTasks, upsertProject, upsertTask } from "./store-BLldgiix.js";
//#region src/business/auto-drive.ts
/** 从 Cordis Context 构造自动驱动运行时（复用 engine 的 agent 服务）。 */
function autoDriveRuntimeFromCtx(ctx, cwd) {
	const agents = ctx.get("agents");
	const agentPresets = ctx.get("agentPresets");
	const workspaceRegistry = ctx.get("workspaceRegistry");
	return {
		cwd,
		async wakeRole(projectId, role, text, reqId) {
			const sessionId = reqId ? `session-${projectId}-${reqId}-${role}` : `session-${projectId}-${role}`;
			const live = agents?.get(sessionId);
			if (!live || typeof live.followup !== "function") return false;
			live.followup(createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-agiteam",
					form: "instructions"
				}
			}));
			return true;
		},
		async createRole(projectId, role, roleCwd, greeting, reqId) {
			if (!agents || !agentPresets) throw new Error("agents/agentPresets 服务不可用");
			const sessionId = reqId ? `session-${projectId}-${reqId}-${role}` : `session-${projectId}-${role}`;
			const presetId = {
				supervisor: "agiteam-supervisor",
				requirement: "agiteam-requirement",
				architect: "agiteam-architect",
				product: "agiteam-product",
				"req-reviewer": "agiteam-req-reviewer",
				"prod-reviewer": "agiteam-prod-reviewer",
				"test-designer": "agiteam-test-designer",
				developer: "agiteam-developer",
				tester: "agiteam-tester"
			}[role];
			try {
				await agentPresets.resolve(presetId);
				const handle = await agents.create({
					sessionId,
					meta: {
						cwd: roleCwd,
						agentPreset: presetId
					},
					setup: async (agentCtx) => {
						await agentPresets.mount(agentCtx, presetId);
					}
				});
				if (!handle?.agent || typeof handle.agent.followup !== "function") throw new Error(`角色会话创建返回异常（sessionId=${sessionId}, preset=${presetId}, keys=${Object.keys(handle ?? {}).join(",") || "空"}）`);
				const agentSession = handle.agent.session;
				console.error(`[dsh-agiteam] 角色会话创建成功（sessionId=${sessionId}, preset=${presetId}, agentSession=${agentSession?.id ?? "无"}）`);
				handle.agent.followup(createUserMessage({
					content: [{
						type: "text",
						text: greeting
					}],
					source: {
						kind: "plugin",
						plugin: "dsh-agiteam",
						form: "instructions"
					}
				}));
				if (workspaceRegistry) try {
					const ws = await workspaceRegistry.resolveByPath(roleCwd);
					if (ws && typeof ws.attachSession === "function") await ws.attachSession(sessionId);
				} catch {}
			} catch (err) {
				const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
				console.error(`[dsh-agiteam] 创建角色会话失败（role=${role}, sessionId=${sessionId}, preset=${presetId}, cwd=${roleCwd}）:\n${detail}`);
				throw new Error(`创建角色会话失败（role=${role}, sessionId=${sessionId}, cwd=${roleCwd}）：\n${detail}`);
			}
		}
	};
}
/** 阶段引导消息。 */
function stageGreeting(project, stage, extra) {
	const name = STAGE_NAMES[stage] ?? stage;
	const role = STAGE_ROLE[stage];
	const roleName = role ? ROLE_NAMES[role] : "对应角色";
	const lines = [`【dsh-agiteam】项目「${project.name}」进入阶段：${name}。`, `你作为${roleName}，请完成本阶段工作。`];
	if (extra) lines.push("", extra);
	lines.push("", "完成后调用 agiteam_done 提交结果（评审阶段调用 agiteam_review 判定）。");
	return lines.join("\n");
}
/** 创建阶段任务（若该阶段尚无 open 任务）。 */
async function ensureStageTask(domain, project, stage) {
	const existing = openTasks(domain, project.id);
	if (existing.length > 0) return existing[0];
	const role = STAGE_ROLE[stage];
	if (!role) return void 0;
	const task = {
		id: `T-${Date.now().toString(36)}`,
		projectId: project.id,
		stage,
		title: `${STAGE_NAMES[stage] ?? stage}（${ROLE_NAMES[role]}）`,
		role,
		status: "open",
		result: "",
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	await upsertTask(domain, task);
	return task;
}
/**
* 阶段完成自动推进（agiteam_done 核心）。
* @param ctx 插件上下文
* @param domain 存储域
* @param rt 自动驱动运行时
* @param projectId 项目 id
* @param result 完成结果描述
* @returns 推进后的项目记录
*/
async function autoAdvance(ctx, domain, rt, projectId, result) {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const currentTasks = listTasks(domain, projectId);
	for (const task of currentTasks.filter((t) => t.status === "open" || t.status === "claimed")) await upsertTask(domain, {
		...task,
		status: "done",
		result,
		updatedAt: Date.now()
	});
	const auditSeq = nextAuditSeq(domain, projectId);
	const prevHash = lastAuditHash(domain, projectId);
	await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
		time: Date.now(),
		action: "stage-done",
		role: STAGE_ROLE[project.stage] ?? "system",
		projectId,
		stage: project.stage,
		detail: JSON.stringify({
			stage: project.stage,
			result
		})
	}, prevHash));
	const current = project.stage;
	if (isReviewStage(current)) return project;
	const next = nextStage(current);
	if (!next) {
		project.stage = "done";
		project.completed[current] = true;
		project.updatedAt = Date.now();
		await upsertProject(domain, project);
		return project;
	}
	project.stage = next;
	project.completed[current] = true;
	project.updatedAt = Date.now();
	await upsertProject(domain, project);
	const role = STAGE_ROLE[next];
	if (role) {
		const greeting = stageGreeting(project, next);
		if (!await rt.wakeRole(projectId, role, greeting, project.currentReqId || void 0)) await rt.createRole(projectId, role, rt.cwd, greeting, project.currentReqId || void 0);
	}
	return project;
}
/** 评审判定（agiteam_review 核心）：通过前进，打回返回上一阶段。 */
async function reviewDecision(ctx, domain, rt, projectId, passed, comment) {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const current = project.stage;
	if (!isReviewStage(current)) throw new Error(`当前阶段 ${current} 不是评审阶段`);
	const comments = project.reviewComments[current] ?? [];
	comments.push(comment);
	project.reviewComments[current] = comments;
	const auditSeq = nextAuditSeq(domain, projectId);
	const prevHash = lastAuditHash(domain, projectId);
	await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
		time: Date.now(),
		action: passed ? "review-pass" : "review-reject",
		role: STAGE_ROLE[current] ?? "reviewer",
		projectId,
		stage: current,
		detail: JSON.stringify({
			stage: current,
			passed,
			comment
		})
	}, prevHash));
	if (passed) {
		const next = nextStage(current);
		if (next) {
			project.stage = next;
			project.completed[current] = true;
			project.updatedAt = Date.now();
			await upsertProject(domain, project);
			const role = STAGE_ROLE[next];
			if (role) {
				const greeting = stageGreeting(project, next);
				if (!await rt.wakeRole(projectId, role, greeting, project.currentReqId || void 0)) await rt.createRole(projectId, role, rt.cwd, greeting, project.currentReqId || void 0);
			}
		}
	} else {
		const back = reviewBackTo(current);
		if (back) {
			project.stage = back;
			project.updatedAt = Date.now();
			await upsertProject(domain, project);
			const role = STAGE_ROLE[back];
			if (role) {
				const greeting = stageGreeting(project, back, `【评审打回】意见：${comment}`);
				if (!await rt.wakeRole(projectId, role, greeting, project.currentReqId || void 0)) await rt.createRole(projectId, role, rt.cwd, greeting, project.currentReqId || void 0);
			}
		}
	}
	return project;
}
/** 计算下一个审计 seq。 */
function nextAuditSeq(domain, projectId) {
	const last = lastAudit(domain, projectId);
	return last ? last.seq + 1 : 1;
}
/** 计算审计链 prevHash（末条 hash，无则 GENESIS）。 */
function lastAuditHash(domain, projectId) {
	const last = lastAudit(domain, projectId);
	return last ? last.hash : "GENESIS";
}
//#endregion
export { autoAdvance, autoDriveRuntimeFromCtx, ensureStageTask, reviewDecision, stageGreeting };

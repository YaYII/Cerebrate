import { a as ReasoningEffortId, o as createUserMessage, r as STAGE_ROLE, t as ROLE_NAMES } from "./roles-5s3BTTZr.js";
import { i as reviewBackTo, n as isReviewStage, r as nextStage, t as STAGE_NAMES } from "./stage-6kxWDxZR.js";
import { n as makeAuditEntry } from "./audit-CJNju73G.js";
import { appendAuditRecord, getProject, lastAudit, listTasks, openTasks, upsertProject, upsertTask } from "./store-DSkktQf9.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
//#region src/features/kb-sync.ts
/**
* Obsidian 团队知识库同步 —— 把 agiteam 阶段产物按规范落盘到团队知识库。
*
* 规范（见 团队知识库/IHM2-无息贷款/ 的 README 索引）：
*   团队知识库/<项目>/<需求大类>/<具体需求>/
*     ├── 需求清单.md   ← requirements.md
*     ├── 产品方案.md   ← features.md
*     ├── 测试用例.md   ← testcases.md
*     ├── 评审记录.md   ← 评审意见/打回记录
*     └── 验收报告.md   ← acceptance.md / e2e.md
*
* 纯能力砖块：不依赖业务层，只做「读源文件 → 生成规范文件 → 写 vault」。
*/
/** 团队知识库 vault 根目录（Obsidian vault）。 */
const KB_VAULT_ROOT = join(process.env.HOME ?? "/home/as-workstation01", "Documents", "team-kb", "团队知识库");
/** 知识库规范文件 → 工程产物文件的映射（阶段产物名 → 知识库文件名）。 */
const KB_FILE_MAP = {
	requirements: "需求清单.md",
	features: "产品方案.md",
	testcases: "测试用例.md",
	acceptance: "验收报告.md"
};
/** 工程产物目录相对项目 cwd 的路径。 */
const ARTIFACT_REL = {
	requirements: "requirements/requirements.md",
	features: "features/features.md",
	testcases: "testcases/testcases.md",
	acceptance: "acceptance.md"
};
/** 读取工程产物（返回 undefined 表示不存在）。 */
async function readArtifact(projectCwd, artifact) {
	const rel = ARTIFACT_REL[artifact];
	if (!rel) return void 0;
	try {
		return await readFile(join(projectCwd, rel), "utf8");
	} catch {
		return;
	}
}
/**
* 把一份工程产物同步为知识库规范文档。
* @param projectCwd 工程根目录
* @param kbDir 知识库目标目录（团队知识库/<项目>/<需求大类>/<具体需求>/）
* @param artifact 产物类型（requirements/features/testcases/acceptance）
* @returns 写入的文件名；产物不存在返回 undefined
*/
async function syncArtifactToKb(projectCwd, kbDir, artifact) {
	const content = await readArtifact(projectCwd, artifact);
	const fileName = KB_FILE_MAP[artifact];
	if (!content || !fileName) return void 0;
	const withMeta = content.includes("---\n") ? content : [
		"---",
		`created: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
		`updated: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
		`tags: [dsh-agiteam, ${artifact}]`,
		"---",
		"",
		content
	].join("\n");
	const absDir = join(KB_VAULT_ROOT, kbDir);
	await mkdir(absDir, { recursive: true });
	await writeFile(join(absDir, fileName), withMeta, "utf8");
	return fileName;
}
/**
* 把评审意见/打回记录同步为《评审记录.md》。
* @param kbDir 知识库目标目录
* @param stageName 阶段名（需求评审/产品评审/用例评审）
* @param entries 评审记录行（每条一行文本）
* @returns 写入的文件名
*/
async function syncReviewToKb(kbDir, stageName, entries) {
	const body = [
		"---",
		`created: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
		`updated: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
		"tags: [dsh-agiteam, 评审记录]",
		"---",
		"",
		`# ${stageName}评审记录`,
		"",
		...entries.length > 0 ? entries : ["（暂无评审记录）"]
	].join("\n");
	const absDir = join(KB_VAULT_ROOT, kbDir);
	await mkdir(absDir, { recursive: true });
	await writeFile(join(absDir, "评审记录.md"), body, "utf8");
	return "评审记录.md";
}
//#endregion
//#region src/business/auto-drive.ts
/** 从 Cordis Context 构造自动驱动运行时（复用 engine 的 agent 服务）。 */
function autoDriveRuntimeFromCtx(ctx, cwd) {
	const agents = ctx.get("agents");
	const agentPresets = ctx.get("agentPresets");
	const workspaceRegistry = ctx.get("workspaceRegistry");
	const fs = ctx.get("fs");
	return {
		cwd,
		async exists(absPath) {
			if (!fs) return false;
			try {
				const target = await fs.resolve(absPath);
				return await fs.stat(target) !== void 0;
			} catch {
				return false;
			}
		},
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
		async createRole(projectId, role, roleCwd, greeting, reqId, modelOpts) {
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
				const callerAgent = ctx.agent;
				const headerConfig = callerAgent?.session?.requestHeader?.()?.config;
				const agentOptionsFinal = {};
				const srcProvider = modelOpts?.provider || headerConfig?.provider || callerAgent?.options?.provider;
				const srcModel = modelOpts?.model || headerConfig?.model || callerAgent?.options?.model;
				const srcEffort = modelOpts?.effort || headerConfig?.reasoningEffort || callerAgent?.options?.reasoningEffort;
				if (srcProvider) agentOptionsFinal.provider = srcProvider;
				if (srcModel) agentOptionsFinal.model = srcModel;
				if (srcEffort) agentOptionsFinal.reasoningEffort = ReasoningEffortId(srcEffort);
				console.error(`[dsh-agiteam] 角色模型继承（${role}）：provider=${srcProvider ?? "无"}, model=${srcModel ?? "无"}, effort=${srcEffort ?? "无"}`);
				const handle = await agents.create({
					sessionId,
					meta: {
						cwd: roleCwd,
						agentPreset: presetId
					},
					...Object.keys(agentOptionsFinal).length > 0 ? { agentOptions: agentOptionsFinal } : {},
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
	const role = STAGE_ROLE[next];
	if (role) {
		const greeting = stageGreeting(project, next);
		if (!await rt.wakeRole(projectId, role, greeting, project.currentReqId || void 0)) try {
			await rt.createRole(projectId, role, rt.cwd, greeting, project.currentReqId || void 0, {
				provider: project.ownerProvider,
				model: project.ownerModel,
				effort: project.ownerEffort
			});
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[dsh-agiteam] 角色启动失败，阶段流转中断（project=${projectId}, stage=${next}, role=${role}）:\n${detail}`);
			throw new Error(`角色启动失败（${role}），阶段流转已中断：${detail}。请检查角色 preset/模型配置后重试 agiteam_done。`);
		}
	}
	project.stage = next;
	project.completed[current] = true;
	project.updatedAt = Date.now();
	await upsertProject(domain, project);
	try {
		await syncProjectToKb(project, current);
	} catch {}
	const stageName = STAGE_NAMES[next] ?? next;
	notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」已完成，已自动推进到「${stageName}」。${project.kbPath ? "产物已同步到团队知识库。" : ""}请继续指挥。`);
	return project;
}
/** 评审判定（agiteam_review 核心）：通过前进，打回返回上一阶段。 */
async function reviewDecision(ctx, domain, rt, projectId, passed, comment) {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const current = project.stage;
	if (!isReviewStage(current)) throw new Error(`当前阶段 ${current} 不是评审阶段`);
	const expectedArtifact = {
		"req-review": `${project.cwd.replace(/\/+$/, "")}/requirements/requirements.md`,
		"product-review": `${project.cwd.replace(/\/+$/, "")}/features/features.md`,
		"testcase-review": `${project.cwd.replace(/\/+$/, "")}/testcases/testcases.md`
	}[current];
	if (passed && expectedArtifact) {
		if (!await rt.exists(expectedArtifact)) {
			const detail = `评审通过被拒绝：上一阶段产物不存在（${expectedArtifact}）。请先让对应角色产出产物再评审，避免「无产物通过评审」的空转。`;
			console.error(`[dsh-agiteam] ${detail}（project=${projectId}, stage=${current}）`);
			throw new Error(detail);
		}
	}
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
			const role = STAGE_ROLE[next];
			if (role) {
				const greeting = stageGreeting(project, next);
				if (!await rt.wakeRole(projectId, role, greeting, project.currentReqId || void 0)) try {
					await rt.createRole(projectId, role, rt.cwd, greeting, project.currentReqId || void 0, {
						provider: project.ownerProvider,
						model: project.ownerModel,
						effort: project.ownerEffort
					});
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					console.error(`[dsh-agiteam] 评审通过但角色启动失败，阶段流转中断（project=${projectId}, stage=${next}, role=${role}）:\n${detail}`);
					throw new Error(`评审通过但角色启动失败（${role}），阶段流转已中断：${detail}。请检查角色 preset/模型配置后重试 agiteam_review。`);
				}
			}
			project.stage = next;
			project.completed[current] = true;
			project.updatedAt = Date.now();
			await upsertProject(domain, project);
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
				if (!await rt.wakeRole(projectId, role, greeting, project.currentReqId || void 0)) await rt.createRole(projectId, role, rt.cwd, greeting, project.currentReqId || void 0, {
					provider: project.ownerProvider,
					model: project.ownerModel,
					effort: project.ownerEffort
				});
			}
		}
	}
	try {
		await syncProjectToKb(project, current, project.reviewComments[current] ?? []);
	} catch {}
	const verb = passed ? "通过" : "打回";
	const stageName = STAGE_NAMES[project.stage] ?? project.stage;
	notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」评审${verb}，当前阶段：${stageName}。${project.kbPath ? "评审记录已同步到团队知识库。" : ""}请继续指挥。`);
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
/**
* 阶段流转后把产物同步到 Obsidian 团队知识库（best-effort，失败不阻断流程）。
* @param project 项目记录（cwd/kbPath）
* @param stage 当前阶段（决定同步哪些产物）
* @param reviewEntries 评审记录（评审阶段传入）
*/
async function syncProjectToKb(project, stage, reviewEntries) {
	const results = [];
	if (!project.kbPath || !project.cwd) return results;
	try {
		if (isReviewStage(stage)) {
			const kbDir = project.kbPath;
			if (reviewEntries && reviewEntries.length > 0) try {
				const file = await syncReviewToKb(kbDir, STAGE_NAMES[stage] ?? stage, reviewEntries);
				results.push({
					file,
					ok: true
				});
			} catch (err) {
				results.push({
					file: "评审记录.md",
					ok: false
				});
				console.error(`[dsh-agiteam] 评审记录同步失败: ${err instanceof Error ? err.message : String(err)}`);
			}
			const artifact = {
				"req-review": "requirements",
				"product-review": "features",
				"testcase-review": "testcases"
			}[stage];
			if (artifact) try {
				const file = await syncArtifactToKb(project.cwd, kbDir, artifact);
				if (file) results.push({
					file,
					ok: true
				});
			} catch (err) {
				results.push({
					file: KB_FILE_NAME(artifact),
					ok: false
				});
				console.error(`[dsh-agiteam] 产物 ${artifact} 同步失败: ${err instanceof Error ? err.message : String(err)}`);
			}
			return results;
		}
		const artifact = {
			requirement: "requirements",
			product: "features",
			testcase: "testcases",
			"feature-accept": "acceptance",
			"e2e-accept": "acceptance"
		}[stage];
		if (artifact) try {
			const file = await syncArtifactToKb(project.cwd, project.kbPath, artifact);
			if (file) results.push({
				file,
				ok: true
			});
		} catch (err) {
			results.push({
				file: KB_FILE_NAME(artifact),
				ok: false
			});
			console.error(`[dsh-agiteam] 产物 ${artifact} 同步失败: ${err instanceof Error ? err.message : String(err)}`);
		}
		return results;
	} catch (err) {
		console.error(`[dsh-agiteam] 知识库同步异常: ${err instanceof Error ? err.message : String(err)}`);
		return results;
	}
}
/** 产物类型 → 知识库文件名（供失败时展示）。 */
function KB_FILE_NAME(artifact) {
	return {
		requirements: "需求清单.md",
		features: "产品方案.md",
		testcases: "测试用例.md",
		acceptance: "验收报告.md"
	}[artifact] ?? `${artifact}.md`;
}
/**
* 通知项目发起会话（主智能体）：阶段流转完成，请继续指挥。
* 主会话 id 在 agiteam_start 时记录到 project.ownerSession。
* @param ctx 插件上下文（agents 服务）
* @param project 项目记录
* @param message 通知内容
*/
function notifyOwnerSession(ctx, project, message) {
	if (!project.ownerSession) return;
	const owner = ctx.get("agents")?.get(project.ownerSession);
	if (!owner || typeof owner.followup !== "function") {
		console.error(`[dsh-agiteam] 主会话 ${project.ownerSession} 不可用（未唤醒或已结束），无法通知`);
		return;
	}
	owner.followup(createUserMessage({
		content: [{
			type: "text",
			text: message
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-agiteam",
			form: "instructions"
		}
	}));
}
//#endregion
export { autoAdvance, autoDriveRuntimeFromCtx, ensureStageTask, reviewDecision, stageGreeting };

import { n as ReasoningEffortId, r as createUserMessage } from "./lib--NywRvM5.js";
import { i as reviewBackTo, n as isReviewStage, r as nextStage, t as STAGE_NAMES } from "./stage-6kxWDxZR.js";
import { n as makeAuditEntry } from "./audit-CJNju73G.js";
import { r as STAGE_ROLE, t as ROLE_NAMES } from "./roles-BpMTw3gi.js";
import { appendAuditRecord, getProject, lastAudit, listTasks, openTasks, upsertProject, upsertTask } from "./store-CGP5R6Lh.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
/** 审批记录条目 → 一行文本。 */
function approvalEntryLine(entry) {
	return `- ${new Date(entry.time).toLocaleString("zh-CN", { hour12: false })}｜${{
		"stage-done": "提交审批",
		"stage-approved": "审批放行",
		"stage-rejected": "打回返工",
		"stage-paused": "暂停",
		"stage-resumed": "恢复",
		"ai-approval-suggestion": "AI 建议"
	}[entry.action] ?? entry.action}（${entry.source}）｜${entry.title}｜${entry.comment}`;
}
//#endregion
//#region src/business/sessions.ts
/**
* 角色会话管理 —— taskboard 风格：随机唯一 sessionId + 记录 + resume 续接。
*
* 为什么必须随机唯一 + 记录（修复 dsh 崩溃根因）：
*  harness 的会话存储有硬校验：同 id 会话已存在时直接抛错
*  （会话准备阶段：id 已注册即拒绝）。
*  且会话持久化后端在磁盘已有同名日志时拒绝物化
*  （提示用 load/resume 续接而不是重建）。
*  旧实现用固定 id（session-<project>-<role>），进程重启后：
*   1. agents.create() 复用旧 id → 直接抛 already exists → 崩溃；
*   2. 同一项目新需求 R-2 复用 session-<project>-requirement，
*      followup() 把 R-2 内容追加进 R-1 旧对话 → "两个对话内容"。
*
* 本模块的方案（抄袭 taskboard 的 execution/index.ts）：
*  - 每个任务（角色×阶段）首次创建时生成随机 sessionId（agiteam-<uuid>），
*    并记录到任务记录（tasks.sessionId）；
*  - 之后唤醒同一任务：先 agents.get() 命中活会话 → followup；
*    否则 agents.resume({ resumeSessionId: 记录值 }) 续接持久化会话
*    （不 create，天然避开 already exists 崩溃）；
*  - resume 失败（持久化被清/损坏）→ 新建随机 id 并更新任务记录；
*  - 不同任务 = 不同 sessionId = 不同对话，绝不串内容。
*/
/** 从 Cordis Context 读取会话管理服务。 */
function sessionServicesFromCtx(ctx) {
	const services = {
		agents: ctx.get("agents"),
		agentPresets: ctx.get("agentPresets")
	};
	const workspaceRegistry = ctx.get("workspaceRegistry");
	if (workspaceRegistry) services.workspaceRegistry = workspaceRegistry;
	return services;
}
/** 角色 → preset id（与 roles.ts 一致，避免循环依赖）。 */
const ROLE_PRESET = {
	supervisor: "agiteam-supervisor",
	requirement: "agiteam-requirement",
	architect: "agiteam-architect",
	product: "agiteam-product",
	"req-reviewer": "agiteam-req-reviewer",
	"prod-reviewer": "agiteam-prod-reviewer",
	"test-designer": "agiteam-test-designer",
	developer: "agiteam-developer",
	tester: "agiteam-tester"
};
/** 构造随机唯一角色会话 id（taskboard 模式：每个任务一个，绝不复用旧 id）。 */
function randomRoleSessionId() {
	return `agiteam-${randomUUID()}`;
}
/** 从调用方会话继承模型配置（provider/model/effort）。 */
function inheritModel(ctx, modelOpts) {
	const callerAgent = ctx.agent;
	const headerConfig = callerAgent?.session?.requestHeader?.()?.config;
	const srcProvider = modelOpts?.provider || headerConfig?.provider || callerAgent?.options?.provider;
	const srcModel = modelOpts?.model || headerConfig?.model || callerAgent?.options?.model;
	const srcEffort = modelOpts?.effort || headerConfig?.reasoningEffort || callerAgent?.options?.reasoningEffort;
	const out = {};
	if (srcProvider) out.provider = srcProvider;
	if (srcModel) out.model = srcModel;
	if (srcEffort) out.reasoningEffort = ReasoningEffortId(srcEffort);
	return out;
}
/** 会话身份编码进 meta（可恢复归属）。 */
function identityMeta(identity) {
	const meta = {
		agiteamProjectId: identity.projectId,
		agiteamRole: identity.role
	};
	if (identity.reqId) meta.agiteamReqId = identity.reqId;
	if (identity.stage) meta.agiteamStage = identity.stage;
	return meta;
}
/**
* 确保角色会话就绪并投递引导消息。
*
* 续接顺序（taskboard 模式）：
*  1. existingSessionId 且 agents.get() 命中活会话 → followup 投递；
*  2. existingSessionId 且会话已持久化 → agents.resume() 续接同一对话；
*  3. 无记录 / resume 失败 → 创建全新随机 id 会话（返回新 id 供调用方更新记录）。
*
* @param ctx 插件上下文（模型继承）
* @param services 会话服务
* @param identity 角色身份（meta 归属）
* @param cwd 角色工作目录
* @param greeting 引导消息
* @param modelOpts 模型配置（可选）
* @param existingSessionId 任务记录里的历史 sessionId（可选）
* @returns 生效的 sessionId + 是否新建（新建时调用方应更新任务记录）
*/
async function ensureRoleSession(ctx, services, identity, cwd, greeting, modelOpts, existingSessionId) {
	if (!services.agents || !services.agentPresets) throw new Error("agents/agentPresets 服务不可用");
	const presetId = ROLE_PRESET[identity.role];
	if (!presetId) throw new Error(`未知角色 ${identity.role}`);
	await services.agentPresets.resolve(presetId);
	const agentOptions = inheritModel(ctx, modelOpts);
	const setup = async (agentCtx) => {
		await services.agentPresets.mount(agentCtx, presetId);
	};
	const attach = async (sessionId) => {
		if (!services.workspaceRegistry) return;
		try {
			const ws = await services.workspaceRegistry.resolveByPath(cwd);
			if (ws && typeof ws.attachSession === "function") await ws.attachSession(sessionId);
		} catch {}
	};
	const greet = (agent) => {
		agent.followup(createUserMessage({
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
	};
	if (existingSessionId) {
		const live = services.agents.get(existingSessionId);
		if (live && typeof live.followup === "function") {
			console.error(`[dsh-agiteam] 角色会话命中活会话（role=${identity.role}, session=${existingSessionId}）`);
			greet(live);
			return {
				sessionId: existingSessionId,
				created: false
			};
		}
		try {
			const resumed = await services.agents.resume({
				resumeSessionId: existingSessionId,
				agentOptions,
				setup
			});
			if (resumed?.agent && typeof resumed.agent.followup === "function") {
				const sid = resumed.agent.session?.id ?? existingSessionId;
				console.error(`[dsh-agiteam] 角色会话续接成功（role=${identity.role}, session=${sid}）`);
				greet(resumed.agent);
				await attach(sid);
				return {
					sessionId: sid,
					created: false
				};
			}
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[dsh-agiteam] 角色会话续接失败（role=${identity.role}, session=${existingSessionId}）: ${detail}，回退创建新会话`);
		}
	}
	const sessionId = randomRoleSessionId();
	const meta = {
		cwd,
		agentPreset: presetId,
		...identityMeta(identity)
	};
	try {
		const handle = await services.agents.create({
			sessionId,
			meta,
			...Object.keys(agentOptions).length > 0 ? { agentOptions } : {},
			setup
		});
		if (!handle?.agent || typeof handle.agent.followup !== "function") throw new Error(`角色会话创建返回异常（sessionId=${sessionId}, preset=${presetId}, keys=${Object.keys(handle ?? {}).join(",") || "空"}）`);
		console.error(`[dsh-agiteam] 角色会话创建成功（role=${identity.role}, session=${sessionId}, agentSession=${handle.agent.session?.id ?? "无"}）`);
		greet(handle.agent);
		await attach(sessionId);
		return {
			sessionId,
			created: true
		};
	} catch (err) {
		const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
		console.error(`[dsh-agiteam] 创建角色会话失败（role=${identity.role}, sessionId=${sessionId}, preset=${presetId}, cwd=${cwd}）:\n${detail}`);
		throw new Error(`创建角色会话失败（role=${identity.role}, sessionId=${sessionId}, cwd=${cwd}）：\n${detail}`);
	}
}
//#endregion
//#region src/business/auto-drive.ts
/** 从 Cordis Context 构造自动驱动运行时（复用 engine 的 agent 服务）。 */
function autoDriveRuntimeFromCtx(ctx, cwd) {
	const agents = ctx.get("agents");
	ctx.get("agentPresets");
	ctx.get("workspaceRegistry");
	const fs = ctx.get("fs");
	const sessions = sessionServicesFromCtx(ctx);
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
			const legacyId = reqId ? `session-${projectId}-${reqId}-${role}` : `session-${projectId}-${role}`;
			const live = agents?.get(legacyId);
			if (live && typeof live.followup === "function") {
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
			}
			return false;
		},
		async createRole(projectId, role, roleCwd, greeting, reqId, modelOpts) {
			const identity = {
				projectId,
				role
			};
			if (reqId) identity.reqId = reqId;
			await ensureRoleSession(ctx, sessions, identity, roleCwd, greeting, modelOpts);
		},
		async ensureRole(projectId, role, roleCwd, greeting, reqId, modelOpts, existingSessionId) {
			const identity = {
				projectId,
				role
			};
			if (reqId) identity.reqId = reqId;
			const result = await ensureRoleSession(ctx, sessions, identity, roleCwd, greeting, modelOpts, existingSessionId);
			return {
				sessionId: result.sessionId,
				created: result.created
			};
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
		sessionId: "",
		result: "",
		approvalSuggestion: "",
		approvalSource: "human",
		reviewComment: "",
		pausedByHuman: false,
		pauseReason: "",
		createdAt: Date.now(),
		updatedAt: Date.now()
	};
	await upsertTask(domain, task);
	return task;
}
/**
* 唤醒阶段角色（taskboard 完整闭环：随机 id + resume 续接 + 写回任务记录）。
*
* 顺序：
*  1. 读任务记录 sessionId（若有）→ 活会话命中直接 followup；
*  2. 无活会话 → agents.resume() 续接同一持久化会话（不 create，避开崩溃）；
*  3. 无记录/续接失败 → 创建全新随机 id 会话，写回任务记录。
*
* @returns 生效的 sessionId + 是否新建。
*/
async function wakeStageRole(domain, rt, project, role, greeting) {
	const task = listTasks(domain, project.id).filter((t) => t.stage === project.stage && t.status !== "done").sort((a, b) => b.createdAt - a.createdAt)[0];
	const existingSessionId = task?.sessionId || void 0;
	const result = await rt.ensureRole(project.id, role, project.cwd, greeting, project.currentReqId || void 0, {
		provider: project.ownerProvider,
		model: project.ownerModel,
		effort: project.ownerEffort
	}, existingSessionId);
	if (task && result.created) await upsertTask(domain, {
		...task,
		sessionId: result.sessionId,
		status: task.status === "open" ? "claimed" : task.status,
		updatedAt: Date.now()
	});
	return result;
}
/**
* 阶段完成自动推进（agiteam_done 核心）。
*
* 任务板审批模式：
*  1. 角色完成阶段 → 当前阶段任务提交 in_review（含完成结果 + 审批建议）；
*  2. 通知主会话（你）审批：agiteam_approve 放行 → 推进到下一阶段；
*     或 agiteam_reject 打回（带意见返回返工）；或 agiteam_pause 暂停。
*  3. AI 可代为审批（agiteam_ai_approve 提交建议），但最终放行权在你。
*
* @param ctx 插件上下文
* @param domain 存储域
* @param rt 自动驱动运行时
* @param projectId 项目 id
* @param result 完成结果描述
* @param suggestion 审批建议（AI 代审批时附带）
* @returns 推进后的项目记录
*/
async function autoAdvance(ctx, domain, rt, projectId, result, suggestion = "") {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const currentTasks = listTasks(domain, projectId);
	for (const task of currentTasks.filter((t) => t.status === "open" || t.status === "claimed" || t.status === "in_progress")) await upsertTask(domain, {
		...task,
		status: "in_review",
		result,
		approvalSuggestion: suggestion,
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
			result,
			suggestion
		})
	}, prevHash));
	const current = project.stage;
	if (isReviewStage(current)) return project;
	const stageName = STAGE_NAMES[current] ?? current;
	notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${stageName}」已完成，任务已提交审批（in_review）。请审批：agiteam_approve 放行推进，或 agiteam_reject 打回，或 agiteam_pause 暂停。`);
	return project;
}
/**
* 人工审批放行阶段（agiteam_approve）：in_review → done，推进到下一阶段。
* 只有 human（你）可调用。审批后可选择是否立即推进（默认推进）。
*/
async function approveStage(ctx, domain, rt, projectId, comment = "", advanceNext = true) {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const currentTasks = listTasks(domain, projectId);
	for (const task of currentTasks.filter((t) => t.status === "in_review")) await upsertTask(domain, {
		...task,
		status: "done",
		approvalSource: "human",
		reviewComment: comment,
		approvedAt: Date.now(),
		updatedAt: Date.now()
	});
	const auditSeq = nextAuditSeq(domain, projectId);
	const prevHash = lastAuditHash(domain, projectId);
	const current = project.stage;
	await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
		time: Date.now(),
		action: "stage-approved",
		role: "human",
		projectId,
		stage: current,
		detail: JSON.stringify({
			stage: current,
			comment,
			approvalSource: "human"
		})
	}, prevHash));
	if (isReviewStage(current)) return project;
	const next = nextStage(current);
	if (!next) {
		project.stage = "done";
		project.completed[current] = true;
		project.updatedAt = Date.now();
		await upsertProject(domain, project);
		return project;
	}
	if (!advanceNext) {
		project.updatedAt = Date.now();
		await upsertProject(domain, project);
		return project;
	}
	const role = STAGE_ROLE[next];
	if (role) {
		const nextProject = {
			...project,
			stage: next
		};
		await ensureStageTask(domain, nextProject, next);
		const greeting = stageGreeting(project, next);
		try {
			await wakeStageRole(domain, rt, nextProject, role, greeting);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[dsh-agiteam] 审批通过但角色启动失败，阶段流转中断（project=${projectId}, stage=${next}, role=${role}）:\n${detail}`);
			throw new Error(`审批通过但角色启动失败（${role}），阶段流转已中断：${detail}。请检查角色 preset/模型配置后重试 agiteam_approve。`);
		}
	}
	project.stage = next;
	project.completed[current] = true;
	project.updatedAt = Date.now();
	await upsertProject(domain, project);
	try {
		await syncProjectToKb(project, current);
	} catch {}
	try {
		await syncApprovalToKb(project, {
			time: Date.now(),
			taskId: currentTasks.find((t) => t.stage === current)?.id ?? "",
			title: STAGE_NAMES[current] ?? current,
			stage: current,
			action: "stage-approved",
			source: "human",
			comment
		});
	} catch {}
	const nextName = STAGE_NAMES[next] ?? next;
	notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」已审批放行，自动推进到「${nextName}」。${project.kbPath ? "产物已同步到团队知识库。" : ""}请继续指挥。`);
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
				const nextProject = {
					...project,
					stage: next
				};
				await ensureStageTask(domain, nextProject, next);
				const greeting = stageGreeting(project, next);
				try {
					await wakeStageRole(domain, rt, nextProject, role, greeting);
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
				const backProject = {
					...project,
					stage: back
				};
				await ensureStageTask(domain, backProject, back);
				const greeting = stageGreeting(project, back, `【评审打回】意见：${comment}`);
				try {
					await wakeStageRole(domain, rt, backProject, role, greeting);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					console.error(`[dsh-agiteam] 评审打回后角色启动失败（project=${projectId}, stage=${back}, role=${role}）:\n${detail}`);
				}
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
/**
* 把当前审批动作同步到 Obsidian 任务板审批记录（best-effort，失败不阻断）。
* @param project 项目记录（kbPath）
* @param entry 审批记录条目
*/
async function syncApprovalToKb(project, entry) {
	if (!project.kbPath) return;
	try {
		const { readFile, writeFile, mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { KB_VAULT_ROOT } = await import("./kb-sync-D9fI-l02.js");
		const absDir = join(KB_VAULT_ROOT, project.kbPath);
		const target = join(absDir, "任务板审批记录.md");
		await mkdir(absDir, { recursive: true });
		let prev = "";
		try {
			prev = await readFile(target, "utf8");
		} catch {}
		const line = approvalEntryLine(entry);
		if (prev.includes(line)) return;
		await writeFile(target, `${prev.trimEnd()}\n${line}\n`, "utf8");
	} catch {}
}
/**
* 人工打回阶段（agiteam_reject）：in_review → rejected，带意见返回返工。
* 只有 human（你）可调用。
*/
async function rejectStage(ctx, domain, rt, projectId, comment) {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const current = project.stage;
	const currentTasks = listTasks(domain, projectId);
	for (const task of currentTasks.filter((t) => t.status === "in_review")) await upsertTask(domain, {
		...task,
		status: "rejected",
		reviewComment: comment,
		approvalSource: "human",
		updatedAt: Date.now()
	});
	const auditSeq = nextAuditSeq(domain, projectId);
	const prevHash = lastAuditHash(domain, projectId);
	await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
		time: Date.now(),
		action: "stage-rejected",
		role: "human",
		projectId,
		stage: current,
		detail: JSON.stringify({
			stage: current,
			comment
		})
	}, prevHash));
	const back = reviewBackTo(current) ?? current;
	project.stage = back;
	project.updatedAt = Date.now();
	await upsertProject(domain, project);
	const role = STAGE_ROLE[back];
	if (role) {
		const backProject = {
			...project,
			stage: back
		};
		await ensureStageTask(domain, backProject, back);
		const greeting = stageGreeting(project, back, `【打回返工】意见：${comment}`);
		try {
			await wakeStageRole(domain, rt, backProject, role, greeting);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[dsh-agiteam] 打回后角色启动失败（project=${projectId}, stage=${back}, role=${role}）:\n${detail}`);
		}
	}
	const backName = STAGE_NAMES[back] ?? back;
	try {
		await syncApprovalToKb(project, {
			time: Date.now(),
			taskId: currentTasks.find((t) => t.stage === current)?.id ?? "",
			title: STAGE_NAMES[current] ?? current,
			stage: current,
			action: "stage-rejected",
			source: "human",
			comment
		});
	} catch {}
	notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」被打回（${comment}），返回阶段「${backName}」返工。`);
	return project;
}
/**
* 人工暂停阶段（agiteam_pause）：随时暂停当前阶段（你是魔王）。
* paused 任务不会自动推进；恢复用 agiteam_resume。
*/
async function pauseStage(ctx, domain, projectId, reason) {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const current = project.stage;
	const currentTasks = listTasks(domain, projectId);
	for (const task of currentTasks.filter((t) => t.status !== "done" && t.status !== "failed")) await upsertTask(domain, {
		...task,
		status: "paused",
		pausedByHuman: true,
		pauseReason: reason,
		updatedAt: Date.now()
	});
	const auditSeq = nextAuditSeq(domain, projectId);
	const prevHash = lastAuditHash(domain, projectId);
	await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
		time: Date.now(),
		action: "stage-paused",
		role: "human",
		projectId,
		stage: current,
		detail: JSON.stringify({
			stage: current,
			reason
		})
	}, prevHash));
	try {
		await syncApprovalToKb(project, {
			time: Date.now(),
			taskId: currentTasks.find((t) => t.stage === current)?.id ?? "",
			title: STAGE_NAMES[current] ?? current,
			stage: current,
			action: "stage-paused",
			source: "human",
			comment: reason
		});
	} catch {}
	notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」已暂停（${reason}）。恢复用 agiteam_resume。`);
	return project;
}
/**
* 恢复暂停阶段（agiteam_resume）：paused → in_progress，继续当前阶段。
*/
async function resumeStage(ctx, domain, rt, projectId) {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const current = project.stage;
	const currentTasks = listTasks(domain, projectId);
	for (const task of currentTasks.filter((t) => t.status === "paused")) await upsertTask(domain, {
		...task,
		status: "in_progress",
		pausedByHuman: false,
		pauseReason: "",
		updatedAt: Date.now()
	});
	const auditSeq = nextAuditSeq(domain, projectId);
	const prevHash = lastAuditHash(domain, projectId);
	await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
		time: Date.now(),
		action: "stage-resumed",
		role: "human",
		projectId,
		stage: current,
		detail: JSON.stringify({ stage: current })
	}, prevHash));
	const role = STAGE_ROLE[current];
	if (role) {
		const greeting = stageGreeting(project, current, "【恢复】任务已恢复，请继续完成本阶段工作。");
		try {
			await wakeStageRole(domain, rt, project, role, greeting);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[dsh-agiteam] 恢复后角色启动失败（project=${projectId}, stage=${current}, role=${role}）:\n${detail}`);
		}
	}
	try {
		await syncApprovalToKb(project, {
			time: Date.now(),
			taskId: currentTasks.find((t) => t.stage === current)?.id ?? "",
			title: STAGE_NAMES[current] ?? current,
			stage: current,
			action: "stage-resumed",
			source: "human",
			comment: "恢复执行"
		});
	} catch {}
	notifyOwnerSession(ctx, project, `【dsh-agiteam】项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」已恢复，角色已唤醒继续。`);
	return project;
}
/**
* AI 代为审批（agiteam_ai_approve）：AI 依据验收标准给出审批建议，
* 提交到任务（in_review 或直接建议），但最终放行权在 human（你）。
* 返回建议详情，供你决定采纳/驳回。
*/
async function aiApproveSuggestion(ctx, domain, projectId, suggestion, approve) {
	const project = getProject(domain, projectId);
	if (!project) throw new Error(`项目 ${projectId} 不存在`);
	const current = project.stage;
	const currentTasks = listTasks(domain, projectId);
	for (const task of currentTasks.filter((t) => t.status === "in_review")) await upsertTask(domain, {
		...task,
		approvalSuggestion: suggestion,
		approvalSource: "ai",
		reviewComment: approve ? "AI 建议放行（等待人工确认）" : `AI 建议打回：${suggestion}`,
		updatedAt: Date.now()
	});
	const auditSeq = nextAuditSeq(domain, projectId);
	const prevHash = lastAuditHash(domain, projectId);
	await appendAuditRecord(domain, makeAuditEntry(auditSeq, {
		time: Date.now(),
		action: "ai-approval-suggestion",
		role: "ai",
		projectId,
		stage: current,
		detail: JSON.stringify({
			stage: current,
			suggestion,
			approve
		})
	}, prevHash));
	notifyOwnerSession(ctx, project, `【dsh-agiteam】AI 对项目「${project.name}」阶段「${STAGE_NAMES[current] ?? current}」给出审批建议：${approve ? "建议放行" : "建议打回"}。${suggestion}。最终决定权在你：agiteam_approve / agiteam_reject。`);
	return project;
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
export { syncArtifactToKb as a, aiApproveSuggestion, approveStage, autoAdvance, autoDriveRuntimeFromCtx, ensureStageTask, readArtifact as i, KB_VAULT_ROOT as n, syncReviewToKb as o, pauseStage, approvalEntryLine as r, rejectStage, resumeStage, reviewDecision, stageGreeting, KB_FILE_MAP as t, wakeStageRole };

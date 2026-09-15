import { t as __exportAll } from "./rolldown-runtime-8H4AJuhK.js";
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
var taskboard_bridge_exports = /* @__PURE__ */ __exportAll({
	AGITEAM_NEXT_STAGE: () => AGITEAM_NEXT_STAGE,
	AGITEAM_STAGE_NAMES: () => AGITEAM_STAGE_NAMES,
	AGITEAM_STAGE_ROLE: () => AGITEAM_STAGE_ROLE,
	agiteamSourceOf: () => agiteamSourceOf,
	encodeAgiteamSource: () => encodeAgiteamSource,
	loadTaskboard: () => loadTaskboard,
	openTaskboardDatabase: () => openTaskboardDatabase,
	stageLabel: () => stageLabel
});
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
export { encodeAgiteamSource as a, taskboard_bridge_exports as c, agiteamSourceOf as i, AGITEAM_STAGE_NAMES as n, openTaskboardDatabase as o, AGITEAM_STAGE_ROLE as r, stageLabel as s, AGITEAM_NEXT_STAGE as t };

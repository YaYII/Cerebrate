//#region src/business/roles.ts
/** 角色中文名。 */
const ROLE_NAMES = {
	supervisor: "主管",
	requirement: "需求分析师",
	architect: "架构师",
	product: "产品经理",
	"req-reviewer": "需求评审员",
	"prod-reviewer": "产品评审员",
	"test-designer": "测试设计师",
	developer: "开发工程师",
	tester: "测试验收员"
};
/** 角色 → 对应 agent preset id。 */
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
/** 各阶段 → 主要负责角色（用于编排时决定创建/唤醒哪个角色 agent）。 */
const STAGE_ROLE = {
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
//#endregion
export { ROLE_PRESET as n, STAGE_ROLE as r, ROLE_NAMES as t };

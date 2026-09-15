import { t as __exportAll } from "./rolldown-runtime-8H4AJuhK.js";
//#region src/features/stage.ts
var stage_exports = /* @__PURE__ */ __exportAll({
	STAGE_NAMES: () => STAGE_NAMES,
	isReviewStage: () => isReviewStage,
	nextStage: () => nextStage,
	reviewBackTo: () => reviewBackTo
});
/** 阶段中文名（用于文档/消息）。 */
const STAGE_NAMES = {
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
/** 正常顺序的下一阶段（不含 done）。 */
const NEXT = {
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
/** 评审阶段 → 被打回时回到的上一阶段。 */
const REVIEW_BACK = {
	"req-review": "requirement",
	"product-review": "product",
	"testcase-review": "testcase"
};
/** 是否评审阶段。 */
function isReviewStage(stage) {
	return stage === "req-review" || stage === "product-review" || stage === "testcase-review";
}
/** 下一阶段；done 无后继返回 undefined。 */
function nextStage(stage) {
	return NEXT[stage];
}
/** 评审打回目标；非评审阶段返回 undefined。 */
function reviewBackTo(stage) {
	return REVIEW_BACK[stage];
}
//#endregion
export { stage_exports as a, reviewBackTo as i, isReviewStage as n, nextStage as r, STAGE_NAMES as t };

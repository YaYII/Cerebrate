import { t as __exportAll } from "./rolldown-runtime-8H4AJuhK.js";
import { createHash } from "node:crypto";
//#region src/features/audit.ts
/**
* 审计日志 —— 追加式 JSONL + sha256 链式指纹。
*
* 为什么独立成砖块：审计是纯数据能力（追加/哈希/校验），无 agent/业务依赖。
*
* 防篡改设计：
*  1. 追加式：只允许 append，不允许改写历史（业务层保证只追加）；
*  2. 链式哈希：每条目的 hash = sha256(seq|time|action|role|detail|fingerprint|prevHash)，
*     下一条目记录 prevHash —— 任何一条被篡改，其后所有 hash 校验失败；
*  3. 指纹：关键动作携带数据指纹（如产物 sha256），校验数据未被替换。
*
* 审计日志落盘：<项目>/.teamdev/<projectId>/audit.jsonl（每行一条 JSON）。
*/
var audit_exports = /* @__PURE__ */ __exportAll({
	entryHash: () => entryHash,
	lineToEntry: () => lineToEntry,
	makeAuditEntry: () => makeAuditEntry,
	parseAuditLog: () => parseAuditLog,
	sha256Hex: () => sha256Hex,
	verifyAuditChain: () => verifyAuditChain,
	verifyEntryHash: () => verifyEntryHash
});
/** 计算 sha256 十六进制摘要。 */
function sha256Hex(input) {
	return createHash("sha256").update(input).digest("hex");
}
/** 计算一条审计条目的哈希（不含 hash 字段本身）。 */
function entryHash(entry) {
	return sha256Hex([
		entry.seq,
		entry.time,
		entry.action,
		entry.role,
		entry.projectId,
		entry.stage,
		entry.detail,
		entry.fingerprint ?? "",
		entry.prevHash
	].join("|"));
}
/** 构造一条审计条目（自动计算 hash）。 */
function makeAuditEntry(seq, input, prevHash) {
	const base = {
		...input,
		seq,
		prevHash
	};
	return {
		...base,
		hash: entryHash(base)
	};
}
/** 校验一条审计条目的哈希是否匹配（未篡改）。 */
function verifyEntryHash(entry) {
	return entry.hash === entryHash(entry);
}
/** 校验整条审计链（每条 hash 自洽 + prevHash 连续）。返回首个断裂位置（-1=完整）。 */
function verifyAuditChain(entries) {
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!verifyEntryHash(entry)) return i;
		if (i > 0 && entry.prevHash !== entries[i - 1].hash) return i;
	}
	return -1;
}
/** 从 JSONL 行解析审计条目（坏行返回 undefined）。 */
function lineToEntry(line) {
	try {
		return JSON.parse(line);
	} catch {
		return;
	}
}
/** 解析审计日志全文（跳过坏行）。 */
function parseAuditLog(text) {
	return text.split("\n").filter((line) => line.trim().length > 0).map((line) => lineToEntry(line)).filter((e) => e !== void 0);
}
//#endregion
export { verifyAuditChain as a, sha256Hex as i, makeAuditEntry as n, parseAuditLog as r, audit_exports as t };

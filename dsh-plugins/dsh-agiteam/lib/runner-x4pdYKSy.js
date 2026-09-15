import { spawn } from "node:child_process";
//#region src/features/runner.ts
/**
* 验收测试执行器 —— 在指定目录运行测试命令（单测/API/脚本/E2E）。
*
* 为什么独立成砖块：环境敏感逻辑（spawn/路径/超时）集中在这里，
* 业务层只需描述"跑什么命令、在哪个目录"，即可获得有界输出与退出码。
*
* 验收模式：
*  - unit   运行单元测试（如 `npm test`）
*  - api    模拟用户请求（如 `curl`/`httpx`/自研脚本）
*  - script 运行自动化脚本（如 `node scripts/e2e.mjs`）
*  - e2e    端到端场景脚本
*/
const DEFAULT_TIMEOUT_MS = 12e4;
const DEFAULT_MAX_OUTPUT = 64 * 1024;
/** 有界捕获一个流（头尾保留、中间截断）。 */
function captureStream(stream, maxBytes) {
	if (stream === null) return Promise.resolve("");
	const head = [];
	const tail = [];
	let headLen = 0;
	let tailLen = 0;
	let sawOverflow = false;
	return new Promise((resolve, reject) => {
		stream.on("data", (chunk) => {
			const len = chunk.length;
			if (headLen + len <= maxBytes) {
				head.push(chunk);
				headLen += len;
			} else {
				sawOverflow = true;
				const remaining = maxBytes - tailLen;
				if (remaining > 0) {
					const slice = len > remaining ? chunk.subarray(len - remaining) : chunk;
					tail.push(slice);
					tailLen += slice.length;
					if (tailLen > maxBytes) tail.shift();
				}
			}
		});
		stream.on("error", reject);
		stream.on("close", () => {
			let text = "";
			if (headLen > 0 || tailLen > 0) text = (sawOverflow ? Buffer.concat([
				...head,
				Buffer.from("\n…<truncated>…\n"),
				...tail
			]) : Buffer.concat(head)).toString("utf8");
			resolve(text);
		});
	});
}
/**
* 运行一条验收命令直到结束（带超时与有界输出）。非零退出不抛错，
* 由调用方检查 exitCode / stderr 判定成败。
*/
async function runAcceptanceCommand(command, args, options) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
	const started = performance.now();
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: process.env,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	let timedOut = false;
	let killed = false;
	let spawnError;
	let settled = false;
	let settleExit = () => {};
	const timer = setTimeout(() => {
		timedOut = true;
		killed = true;
		child.kill("SIGKILL");
		if (!settled) {
			settled = true;
			settleExit(null);
		}
	}, timeoutMs);
	const exitCodeP = new Promise((resolve) => {
		settleExit = resolve;
		child.on("error", (error) => {
			spawnError = `${error.code ?? "spawn"}: ${error.message}`;
			if (!settled) {
				settled = true;
				resolve(killed ? null : -1);
			}
		});
		child.on("close", (code) => {
			if (!settled) {
				settled = true;
				resolve(code);
			}
		});
	});
	const [stdout, stderr] = await Promise.all([captureStream(child.stdout, maxBytes), captureStream(child.stderr, maxBytes)]);
	const exitCode = await exitCodeP;
	clearTimeout(timer);
	return {
		exitCode,
		stdout,
		stderr: `${stderr}${spawnError !== void 0 ? `\n${spawnError}` : ""}`,
		durationMs: Math.round(performance.now() - started),
		timedOut
	};
}
//#endregion
export { runAcceptanceCommand };

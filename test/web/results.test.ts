import { describe, expect, it } from "vitest";
import type { ProbeResponse, QuestionVerdict } from "../../src/shared/types.ts";
import { costLine, diagnosis, dotLabel, failureAdvice, MAX_CALLS_PER_QUESTION, missingNumbers, normalizeKey } from "../../src/web/results.ts";
import type { Attempt } from "../../src/web/runner.ts";

const base = { question: "candy", protocol: "responses" as const, runId: "r", stage: 1, seq: 1, attempt: 1, done: true };
const failed = (response: ProbeResponse | null, attempt: number): Attempt => ({ ...base, attempt, response });
const okWith = (note: string): ProbeResponse => ({
	ok: true,
	questionVersion: 1,
	correct: note === "ok",
	note,
	reasoningTokens: null,
	idShape: "other",
	answer: "21",
	streamed: false,
	ttfbMs: 1,
	ttftMs: null,
	totalMs: 2,
	promptTokens: null,
	cachedTokens: null,
});
const verdict = (status: QuestionVerdict["status"], stage: number, correct: number, total: number): QuestionVerdict => ({
	status,
	stage,
	correct,
	total,
	stages: [],
});

describe("costLine", () => {
	it("counts 31 calls per selected question", () => {
		expect(MAX_CALLS_PER_QUESTION).toBe(31);
		expect(costLine(2)).toBe("已选 2 题，最多 62 次调用。差的站点第一关就停，第 1 关另加 1 次协议探测。");
	});
});

describe("failure mapping", () => {
	it("maps the last failure reason to the design table", () => {
		const attempts = [
			failed({ ok: false, reason: "timeout", httpStatus: null }, 1),
			failed({ ok: false, reason: "unauthorized", httpStatus: 401 }, 2),
		];
		expect(failureAdvice(attempts)).toEqual({ reason: "密钥无效或模型无权限", next: "检查密钥" });
	});

	// A first-run object is only created by an ok call, so failed calls may have no history to download.
	it("makes the raw-download hint conditional because first-run failures are not persisted", () => {
		expect(failureAdvice([failed({ ok: false, reason: "bad_response", httpStatus: 200 }, 1)])).toEqual({
			reason: "站点返回异常",
			next: "若该站点与密钥此前已有历史，可在历史里点「下载原始数据」查看站点返回内容；否则请在本机用 curl 自测该地址",
		});
	});

	it("reports our own endpoint when every attempt was a network error", () => {
		expect(failureAdvice([failed(null, 1)])).toEqual({ reason: "连不上本站接口", next: "检查网络后重测" });
	});

	it("writes a diagnosis per verdict", () => {
		const forbidden = [failed({ ok: false, reason: "forbidden", httpStatus: 403 }, 3)];
		expect(diagnosis(verdict("unavailable", 1, 0, 0), forbidden, "hint")).toBe(
			"第 1 关连续 3 次没有有效响应：站点拒绝了来自服务器的请求。下一步：联系站点，或换网络自测。",
		);
		expect(diagnosis(verdict("failed", 2, 4, 6), [], "回答不是 Yes。")).toBe("第 2 关未达标，答对 4/6。回答不是 Yes。");
		expect(diagnosis(verdict("passed", 4, 31, 31), [], "")).toBe("四关全部通过，答对 31/31。");
		expect(diagnosis(verdict("incomplete", 2, 1, 1), [], "")).toBe("停在第 2 关，测试没有跑完。");
	});
});

describe("dotLabel", () => {
	it("names the call position and its state for screen readers", () => {
		expect(dotLabel({ ...base, stage: 2, seq: 3, done: false, response: null })).toBe("第 2 关第 3 次 尝试 1 · responses：进行中");
		expect(dotLabel(failed(okWith("ok"), 2))).toBe("第 1 关第 1 次 尝试 2 · responses：正确");
		expect(dotLabel(failed(okWith("NO"), 1))).toBe("第 1 关第 1 次 尝试 1 · responses：错误");
		expect(dotLabel(failed({ ok: false, reason: "timeout", httpStatus: null }, 1))).toBe("第 1 关第 1 次 尝试 1 · responses：失败 timeout");
	});
});

describe("missingNumbers", () => {
	it("lists the numbers the numbers scorer reported missing", () => {
		expect(missingNumbers(okWith('missing ["9","12"]'))).toBe("9、12");
		expect(missingNumbers(okWith("ok"))).toBe("");
		expect(missingNumbers(null)).toBe("");
	});
});

describe("normalizeKey", () => {
	it("drops the Bearer prefix and all whitespace", () => {
		expect(normalizeKey("  Bearer sk-ab cd\n")).toBe("sk-abcd");
		expect(normalizeKey("sk-xyz")).toBe("sk-xyz");
	});
});

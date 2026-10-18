import { describe, expect, it } from "vitest";
import { evaluateQuestion, summarizeRun, type LadderCall } from "./ladder.ts";

const call = (stage: number, seq: number, correct: boolean, attempt = 1): LadderCall => ({
	stage,
	seq,
	attempt,
	ok: true,
	correct,
});

const stageCalls = (stage: number, count: number, wrong: number): LadderCall[] =>
	Array.from({ length: count }, (_, i) => call(stage, i + 1, i >= wrong));

describe("evaluateQuestion", () => {
	it("passes with the minimum allowed wrong answers, 28 of 31", () => {
		const calls = [...stageCalls(1, 1, 0), ...stageCalls(2, 5, 1), ...stageCalls(3, 10, 1), ...stageCalls(4, 15, 1)];
		const v = evaluateQuestion(calls);
		expect(v.status).toBe("passed");
		expect(v.correct).toBe(28);
		expect(v.total).toBe(31);
	});

	it("fails at stage 2 when two of five are wrong, without waiting for the rest", () => {
		const calls = [...stageCalls(1, 1, 0), call(2, 1, false), call(2, 2, false)];
		const v = evaluateQuestion(calls);
		expect(v.status).toBe("failed");
		expect(v.stage).toBe(2);
		expect(v.stages[1]!.state).toBe("failed");
	});

	it("is incomplete while a stage still has calls to run", () => {
		const v = evaluateQuestion([...stageCalls(1, 1, 0), call(2, 1, true)]);
		expect(v.status).toBe("incomplete");
		expect(v.stage).toBe(2);
		expect(v.stages[1]!.state).toBe("running");
	});

	it("takes the valid attempt after a failed one", () => {
		const failedFirst: LadderCall = { stage: 1, seq: 1, attempt: 1, ok: false, correct: null };
		const v = evaluateQuestion([failedFirst, call(1, 1, true, 2)]);
		expect(v.stages[0]!.state).toBe("passed");
	});

	it("is unavailable after three failed attempts at one call", () => {
		const fails: LadderCall[] = [1, 2, 3].map((attempt) => ({ stage: 1, seq: 1, attempt, ok: false, correct: null }));
		expect(evaluateQuestion(fails).status).toBe("unavailable");
	});
});

describe("summarizeRun", () => {
	it("separates all passed, partial, failed", () => {
		expect(summarizeRun(["passed", "passed"])).toBe("all_passed");
		expect(summarizeRun(["passed", "failed"])).toBe("partial");
		expect(summarizeRun(["failed", "failed"])).toBe("failed");
	});

	it("lets site-level unavailability dominate and keeps unfinished runs incomplete", () => {
		expect(summarizeRun(["passed", "unavailable"])).toBe("unavailable");
		expect(summarizeRun(["passed", "incomplete"])).toBe("incomplete");
		expect(summarizeRun([])).toBe("incomplete");
	});
});

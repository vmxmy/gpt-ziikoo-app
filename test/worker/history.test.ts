import { describe, expect, it } from "vitest";
import type { CallRecord } from "../../src/shared/types.ts";
import { buildRunViews, planWrite } from "../../src/worker/history.ts";

const RUN_A = "00000000-0000-4000-8000-00000000000a";
const RUN_B = "00000000-0000-4000-8000-00000000000b";

function call(overrides: Partial<CallRecord>): CallRecord {
	return {
		runId: RUN_A,
		questionId: "thibault",
		questionVersion: 1,
		stage: 1,
		seq: 1,
		attempt: 1,
		startedAt: 0,
		protocol: "responses",
		model: "gpt-6-astra",
		effort: null,
		streamed: true,
		httpStatus: 200,
		ok: true,
		reason: null,
		correct: true,
		note: "YES",
		reasoningTokens: 10,
		idShape: "hex",
		ttfbMs: 50,
		ttftMs: 80,
		totalMs: 100,
		promptTokens: null,
		cachedTokens: null,
		truncated: false,
		...overrides,
	};
}

describe("planWrite", () => {
	const tenRuns = Array.from({ length: 10 }, (_, i) => ({ runId: `run-${i}`, startedAt: 1000 - i, calls: 5 }));

	it("drops the oldest run when an 11th run arrives", () => {
		expect(planWrite(tenRuns, "run-new")).toEqual({ kind: "write", deleteRunIds: ["run-9"] });
	});

	it("keeps everything while under 10 runs or when appending to an existing run", () => {
		expect(planWrite(tenRuns.slice(0, 9), "run-new")).toEqual({ kind: "write", deleteRunIds: [] });
		expect(planWrite(tenRuns, "run-3")).toEqual({ kind: "write", deleteRunIds: [] });
	});

	it("rejects the 201st call of a run", () => {
		expect(planWrite([{ runId: RUN_A, startedAt: 0, calls: 200 }], RUN_A)).toEqual({ kind: "reject" });
	});
});

describe("buildRunViews", () => {
	const ladder = [1, 5, 10, 15].flatMap((size, s) => Array.from({ length: size }, (_, i) => ({ stage: s + 1, seq: i + 1 })));
	const thibault = ladder.map((pos, i) => call({ ...pos, startedAt: 10 + i, totalMs: 100 * (i + 1) }));
	const candy = [
		call({ questionId: "candy", startedAt: 5, ok: false, reason: "rate_limited", correct: null, totalMs: 30 }),
		call({
			questionId: "candy",
			startedAt: 6,
			attempt: 2,
			protocol: "chat",
			correct: false,
			note: 'missing ["9","12"]',
			totalMs: 800,
			promptTokens: 128,
			cachedTokens: 64,
		}),
	];
	const older = call({ runId: RUN_B, startedAt: 1, protocol: "chat" });
	const views = buildRunViews([older, ...candy, ...thibault], (id) => (id === "candy" ? "reasoning" : "knowledge"));

	it("orders runs newest first and takes model and protocol from the latest call", () => {
		expect(views.map((v) => [v.runId, v.startedAt, v.protocol, v.overall])).toEqual([
			[RUN_A, 5, "responses", "partial"],
			[RUN_B, 1, "chat", "incomplete"],
		]);
	});

	it("aggregates verdicts and metrics per question", () => {
		const [candyView, thibaultView] = views[0].questions;
		expect(candyView.verdict?.status).toBe("failed");
		expect(candyView.verdict?.stage).toBe(1);
		expect(candyView.metrics).toEqual({
			calls: 2,
			validCalls: 1,
			totalMs: { min: 800, p50: 800, p95: 800, max: 800 },
			ttfbMs: { min: 50, p50: 50, p95: 50, max: 50 },
			ttftMs: { min: 80, p50: 80, p95: 80, max: 80 },
			cacheHitRate: 0.5,
		});
		expect(thibaultView.verdict?.status).toBe("passed");
		expect(thibaultView.verdict?.correct).toBe(31);
		expect(thibaultView.metrics.totalMs).toEqual({ min: 100, p50: 1600, p95: 3000, max: 3100 });
		expect(thibaultView.metrics.cacheHitRate).toBeNull();
	});

	it("leaves metrics-only questions without a verdict", () => {
		const [view] = buildRunViews([call({ questionId: "long-prefix", correct: null })], () => "metrics");
		expect(view.questions[0].verdict).toBeNull();
	});
});

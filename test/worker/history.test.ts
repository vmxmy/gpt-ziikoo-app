import { describe, expect, it } from "vitest";
import type { CallRecord, HistoryRawResponse, RawCall } from "../../src/shared/types.ts";
import { buildRunViews, MAX_RAW_BYTES, planWrite, rawCallsStream, splitCall } from "../../src/worker/history.ts";

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

describe("stage-1 protocol race", () => {
	const raceChatWrong = call({ protocol: "chat", correct: false, note: "NO" });
	const raceResponsesRight = call({ protocol: "responses" });
	const stage2 = [1, 2, 3, 4, 5].map((seq) => call({ stage: 2, seq, startedAt: seq }));

	it.each([
		["chat stored first", [raceChatWrong, raceResponsesRight]],
		["responses stored first", [raceResponsesRight, raceChatWrong]],
	])("counts the responses answer when both protocols answer (%s)", (_, race) => {
		const [view] = buildRunViews([...race, ...stage2], () => "knowledge");
		expect(view.questions[0].verdict?.stages.slice(0, 2).map((s) => s.state)).toEqual(["passed", "passed"]);
		expect(view.questions[0].metrics.calls).toBe(7);
	});
});

function rawCall(overrides: Partial<RawCall>): RawCall {
	return { ...call({}), answer: "Yes", usage: null, rawHeaders: {}, rawBody: null, rawEvents: null, ...overrides };
}

describe("splitCall", () => {
	it("keeps a payload that fits the row budget", () => {
		const { record, raw } = splitCall(rawCall({ rawEvents: [{ t: 1, data: "data: {}" }] }));
		expect(JSON.parse(record).truncated).toBe(false);
		expect(JSON.parse(raw).rawEvents).toEqual([{ t: 1, data: "data: {}" }]);
	});

	it("drops raw events that JSON escaping pushes past the row budget and marks the call truncated", () => {
		const controlBytes = "\u0001".repeat(256 * 1024);
		const { record, raw } = splitCall(rawCall({ answer: controlBytes, rawEvents: [{ t: 1, data: controlBytes }] }));
		expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(MAX_RAW_BYTES);
		expect(JSON.parse(record).truncated).toBe(true);
		expect(JSON.parse(raw)).toMatchObject({ answer: controlBytes, rawEvents: null, rawBody: null });
	});
});

describe("rawCallsStream", () => {
	it("streams the history raw response shape", async () => {
		const calls = [rawCall({ seq: 1 }), rawCall({ seq: 2, answer: null })];
		const expected: HistoryRawResponse = { calls };
		expect(JSON.parse(await new Response(rawCallsStream(calls.values())).text())).toEqual(expected);
		expect(JSON.parse(await new Response(rawCallsStream([].values())).text())).toEqual({ calls: [] });
	});
});

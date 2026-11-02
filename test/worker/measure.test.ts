import { describe, expect, it } from "vitest";
import type { ProbeResponse } from "../../src/shared/types.ts";
import { addRow, applyMeasure, measureDue, measureRow, summarizePerf, type MeasureRow } from "../../src/worker/measure.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const ok = (over: Partial<Extract<ProbeResponse, { ok: true }>> = {}): ProbeResponse => ({
	ok: true,
	questionVersion: 1,
	correct: null,
	note: "unscored",
	reasoningTokens: 100,
	outputTokens: 500,
	idShape: "hex",
	answer: "1",
	streamed: true,
	ttfbMs: 100,
	ttftMs: 1000,
	totalMs: 3000,
	promptTokens: 5000,
	cachedTokens: 4000,
	...over,
});
const failed: ProbeResponse = { ok: false, reason: "timeout", httpStatus: null };
const running = { status: { kind: "running" } as const, seq: 40, intervalMin: 5 };

describe("applyMeasure", () => {
	const state = { measuredSeq: 3, rows: [] };

	it("starts fresh when turned on, keeps results when turned on again or left out, and clears when turned off", () => {
		expect(applyMeasure(undefined, true)).toEqual({ measuredSeq: null, rows: [] });
		expect(applyMeasure(state, true)).toBe(state);
		expect(applyMeasure(state, undefined)).toBe(state);
		expect(applyMeasure(state, false)).toBeUndefined();
	});
});

describe("measureDue", () => {
	it("measures on the first round, then once every 36 rounds on a 5-minute interval", () => {
		expect(measureDue({ measuredSeq: null, rows: [] }, running)).toBe(true);
		expect(measureDue({ measuredSeq: 5, rows: [] }, running)).toBe(false);
		expect(measureDue({ measuredSeq: 4, rows: [] }, running)).toBe(true);
	});

	it("follows the current interval and skips a watch that is not running", () => {
		expect(measureDue({ measuredSeq: 34, rows: [] }, { ...running, intervalMin: 30 })).toBe(true);
		expect(measureDue({ measuredSeq: null, rows: [] }, { ...running, status: { kind: "paused" } })).toBe(false);
	});
});

describe("measureRow", () => {
	it("reads the cache from the second call only and the speed from both", () => {
		expect(measureRow(NOW, ok({ cachedTokens: 0 }), ok({ outputTokens: 900, reasoningTokens: 100 }))).toEqual({
			ts: NOW,
			cache: { promptTokens: 5000, cachedTokens: 4000 },
			speeds: [200, 400],
		});
	});

	it("gives no cache figure for a missing field, a failed call or a prompt below the caching threshold", () => {
		expect(measureRow(NOW, ok(), ok({ cachedTokens: null })).cache).toBeNull();
		expect(measureRow(NOW, ok(), failed).cache).toBeNull();
		expect(measureRow(NOW, ok(), null).cache).toBeNull();
		expect(measureRow(NOW, ok(), ok({ promptTokens: 4095, cachedTokens: 0 })).cache).toBeNull();
	});

	it("keeps a zero cache hit as a figure", () => {
		expect(measureRow(NOW, ok(), ok({ cachedTokens: 0 })).cache).toEqual({ promptTokens: 5000, cachedTokens: 0 });
	});

	it("gives no speed for a short answer, a buffered stream or a failure", () => {
		expect(measureRow(NOW, ok({ outputTokens: 199 }), ok({ ttftMs: 2600 })).speeds).toEqual([]);
		expect(measureRow(NOW, failed, null)).toEqual({ ts: NOW, cache: null, speeds: [] });
	});

	it("ignores figures a site made up", () => {
		expect(measureRow(NOW, ok({ outputTokens: 1e12 }), ok({ promptTokens: -5 }))).toEqual({ ts: NOW, cache: null, speeds: [200] });
		expect(measureRow(NOW, ok(), ok({ cachedTokens: 6000 })).cache).toBeNull();
	});
});

describe("addRow and summarizePerf", () => {
	const row = (hoursAgo: number, over: Partial<MeasureRow> = {}): MeasureRow => ({ ts: NOW - hoursAgo * HOUR, cache: null, speeds: [], ...over });

	it("drops rows older than a day", () => {
		const added = addRow({ measuredSeq: 1, rows: [row(25), row(3)] }, row(0), NOW);
		expect(added).toEqual({ measuredSeq: 1, rows: [row(3), row(0)] });
	});

	it("reports nothing yet before the first measurement", () => {
		expect(summarizePerf({ measuredSeq: null, rows: [] }, 2, 5, NOW)).toEqual({
			checks: 0,
			cacheChecks: 0,
			cacheHitPct: null,
			tokensPerSec: null,
			speedSamples: 0,
			lastAt: null,
			nextInRounds: 0,
		});
	});

	it("sums the cache over the day, takes the median speed, and counts down to the next measurement", () => {
		const rows = [
			row(30, { cache: { promptTokens: 9000, cachedTokens: 9000 }, speeds: [999] }),
			row(6, { cache: { promptTokens: 5000, cachedTokens: 4000 }, speeds: [100, 300] }),
			row(3, { cache: { promptTokens: 5000, cachedTokens: 0 }, speeds: [200] }),
			row(1),
		];
		expect(summarizePerf({ measuredSeq: 26, rows }, 30, 5, NOW)).toEqual({
			checks: 3,
			cacheChecks: 2,
			cacheHitPct: 40,
			tokensPerSec: 200,
			speedSamples: 3,
			lastAt: NOW - HOUR,
			nextInRounds: 32,
		});
	});
});

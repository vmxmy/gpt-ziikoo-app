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
const running = { status: { kind: "running" } as const, seq: 40, intervalMin: 5, firstTry: true };

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

	it("waits for a round that answered on the first try, so a struggling site is not measured", () => {
		expect(measureDue({ measuredSeq: null, rows: [] }, { ...running, firstTry: false })).toBe(false);
		expect(measureDue({ measuredSeq: 4, rows: [] }, { ...running, firstTry: false })).toBe(false);
	});
});

describe("measureRow", () => {
	it("reads the cache on the part the first call had not cached, and the speed from both calls", () => {
		expect(measureRow(NOW, ok({ cachedTokens: 0 }), ok({ cachedTokens: 4900, outputTokens: 900, reasoningTokens: 100 }))).toEqual({
			ts: NOW,
			cache: { promptTokens: 5000, cachedTokens: 4900 },
			cacheVersion: 2,
			speeds: [200, 400],
		});
	});

	it("leaves out the input a site adds and caches on its own", () => {
		const warm = ok({ promptTokens: 22000, cachedTokens: 17000 });
		expect(measureRow(NOW, warm, ok({ promptTokens: 22000, cachedTokens: 22000 })).cache).toEqual({ promptTokens: 5000, cachedTokens: 5000 });
	});

	it("counts as hits only what the second call no longer sent uncached, so reads a site adds on top do not count", () => {
		expect(measureRow(NOW, ok({ promptTokens: 20216, cachedTokens: 14946 }), ok({ promptTokens: 28761, cachedTokens: 23967 })).cache).toEqual({
			promptTokens: 5270,
			cachedTokens: 476,
		});
		expect(measureRow(NOW, ok({ promptTokens: 22013, cachedTokens: 17687 }), ok({ promptTokens: 23068, cachedTokens: 17916 })).cache).toEqual({
			promptTokens: 4326,
			cachedTokens: 0,
		});
	});

	it("counts no fewer hits than none", () => {
		expect(measureRow(NOW, ok({ promptTokens: 9000, cachedTokens: 3000 }), ok({ promptTokens: 9000, cachedTokens: 1000 })).cache).toEqual({
			promptTokens: 6000,
			cachedTokens: 0,
		});
	});

	it("gives no cache figure for a missing field, a failed call, or a first call that already had the fresh prompt cached", () => {
		expect(measureRow(NOW, ok({ cachedTokens: 0 }), ok({ cachedTokens: null })).cache).toBeNull();
		expect(measureRow(NOW, ok({ cachedTokens: null }), ok()).cache).toBeNull();
		expect(measureRow(NOW, ok({ cachedTokens: 0 }), failed).cache).toBeNull();
		expect(measureRow(NOW, ok({ cachedTokens: 0 }), null).cache).toBeNull();
		expect(measureRow(NOW, ok({ cachedTokens: 905 }), ok()).cache).toBeNull();
	});

	it("keeps a zero cache hit as a figure", () => {
		expect(measureRow(NOW, ok({ cachedTokens: 0 }), ok({ cachedTokens: 0 })).cache).toEqual({ promptTokens: 5000, cachedTokens: 0 });
	});

	it("gives no speed for a short answer, a buffered stream or a failure", () => {
		expect(measureRow(NOW, ok({ outputTokens: 199 }), ok({ ttftMs: 2600 })).speeds).toEqual([]);
		expect(measureRow(NOW, failed, null)).toEqual({ ts: NOW, cache: null, cacheVersion: 2, speeds: [] });
	});

	it("ignores figures a site made up", () => {
		expect(measureRow(NOW, ok({ outputTokens: 1e12 }), ok({ promptTokens: -5 }))).toEqual({ ts: NOW, cache: null, cacheVersion: 2, speeds: [200] });
		expect(measureRow(NOW, ok({ cachedTokens: 0 }), ok({ cachedTokens: 6000 })).cache).toBeNull();
		expect(measureRow(NOW, ok({ cachedTokens: 6000 }), ok()).cache).toBeNull();
	});
});

describe("addRow and summarizePerf", () => {
	const row = (hoursAgo: number, over: Partial<MeasureRow> = {}): MeasureRow => ({ ts: NOW - hoursAgo * HOUR, cache: null, cacheVersion: 2, speeds: [], ...over });

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

	it("leaves out the cache figure of a row written before the fresh-number prompt and keeps its speed", () => {
		const before: MeasureRow = { ts: NOW - 2 * HOUR, cache: { promptTokens: 22000, cachedTokens: 17000 }, speeds: [300] };
		const fresh = measureRow(NOW, ok({ promptTokens: 22000, cachedTokens: 17000 }), ok({ promptTokens: 22000, cachedTokens: 17000 }));
		expect(summarizePerf(addRow({ measuredSeq: 40, rows: [before] }, fresh, NOW), 40, 5, NOW)).toMatchObject({
			checks: 2,
			cacheChecks: 1,
			cacheHitPct: 0,
			speedSamples: 3,
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

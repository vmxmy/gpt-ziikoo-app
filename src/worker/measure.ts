import { freshHit } from "../shared/cache-hit.ts";
import type { ProbeResponse } from "../shared/types.ts";
import { measureEveryRounds, type WatchPerf, type WatchStatus } from "../shared/watch.ts";
import { stat } from "./history.ts";
import { validCount } from "./parse.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_ANSWER_TOKENS = 100;
const MIN_STREAM_MS = 500;

// Rows stored before the fresh-number prompt carry no version: their cache figure counts input a site adds as hits, so only their speed still holds.
const CACHE_VERSION = 2;

// cache.promptTokens is the part of the prompt under test; cache.cachedTokens is how much of it the second call no longer sent uncached.
export type MeasureRow = { ts: number; cache: { promptTokens: number; cachedTokens: number } | null; cacheVersion?: number; speeds: number[] };
export type MeasureState = { measuredSeq: number | null; rows: MeasureRow[] };

export function applyMeasure(current: MeasureState | undefined, on: boolean | undefined): MeasureState | undefined {
	if (on === undefined) return current;
	return on ? (current ?? { measuredSeq: null, rows: [] }) : undefined;
}

// Only after a round that answered on the first try: that round took at most one call's timeout, and the two measurement calls add at most two more,
// so the newest sample stays within the 10 minutes before a card reads as no data. A struggling site is not worth the spend either.
export function measureDue(
	measure: MeasureState,
	{ status, seq, intervalMin, firstTry }: { status: WatchStatus; seq: number; intervalMin: number; firstTry: boolean },
): boolean {
	if (status.kind !== "running" || !firstTry) return false;
	return measure.measuredSeq === null || seq - measure.measuredSeq >= measureEveryRounds(intervalMin);
}

// Reasoning comes before the first answer token, so it stays out of both sides. A buffered site delivers the answer at once, which is no speed at all.
function tokensPerSec(r: ProbeResponse): number | null {
	if (!r.ok || r.ttftMs === null) return null;
	const output = validCount(r.outputTokens);
	if (output === null) return null;
	const answer = output - (validCount(r.reasoningTokens) ?? 0);
	const streamMs = r.totalMs - r.ttftMs;
	return answer >= MIN_ANSWER_TOKENS && streamMs >= MIN_STREAM_MS ? answer / (streamMs / 1000) : null;
}

export function measureRow(ts: number, warm: ProbeResponse, hit: ProbeResponse | null): MeasureRow {
	const speeds = [warm, hit].flatMap((r) => {
		const speed = r && tokensPerSec(r);
		return speed ? [speed] : [];
	});
	return { ts, cache: freshHit(warm, hit), cacheVersion: CACHE_VERSION, speeds };
}

export function addRow(state: MeasureState, row: MeasureRow, now: number): MeasureState {
	return { ...state, rows: [...state.rows.filter((r) => r.ts > now - DAY_MS), row] };
}

export function summarizePerf(measure: MeasureState, seq: number, intervalMin: number, now: number): WatchPerf {
	const rows = measure.rows.filter((r) => r.ts > now - DAY_MS);
	const caches = rows.flatMap((r) => (r.cache && r.cacheVersion === CACHE_VERSION ? [r.cache] : []));
	const prompt = caches.reduce((sum, c) => sum + c.promptTokens, 0);
	const cached = caches.reduce((sum, c) => sum + c.cachedTokens, 0);
	const speeds = rows.flatMap((r) => r.speeds);
	return {
		checks: rows.length,
		cacheChecks: caches.length,
		cacheHitPct: prompt > 0 ? (cached / prompt) * 100 : null,
		tokensPerSec: stat(speeds)?.p50 ?? null,
		speedSamples: speeds.length,
		lastAt: rows.at(-1)?.ts ?? null,
		nextInRounds: measure.measuredSeq === null ? 0 : Math.max(0, measureEveryRounds(intervalMin) - (seq - measure.measuredSeq)),
	};
}

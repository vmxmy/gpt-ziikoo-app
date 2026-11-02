import type { ProbeResponse } from "../shared/types.ts";
import { measureEveryRounds, type WatchPerf, type WatchStatus } from "../shared/watch.ts";
import { stat } from "./history.ts";
import { validCount } from "./parse.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Claude's highest documented caching minimum; a shorter prompt reaching us means a site cut it, so its hit rate says nothing.
const MIN_PROMPT_TOKENS = 4096;
const MIN_ANSWER_TOKENS = 100;
const MIN_STREAM_MS = 500;

export type MeasureRow = { ts: number; cache: { promptTokens: number; cachedTokens: number } | null; speeds: number[] };
export type MeasureState = { measuredSeq: number | null; rows: MeasureRow[] };

export function applyMeasure(current: MeasureState | undefined, on: boolean | undefined): MeasureState | undefined {
	if (on === undefined) return current;
	return on ? (current ?? { measuredSeq: null, rows: [] }) : undefined;
}

export function measureDue(measure: MeasureState, { status, seq, intervalMin }: { status: WatchStatus; seq: number; intervalMin: number }): boolean {
	if (status.kind !== "running") return false;
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

function cacheFigures(r: ProbeResponse | null): MeasureRow["cache"] {
	if (!r?.ok) return null;
	const promptTokens = validCount(r.promptTokens);
	const cachedTokens = validCount(r.cachedTokens);
	if (promptTokens === null || cachedTokens === null || promptTokens < MIN_PROMPT_TOKENS || cachedTokens > promptTokens) return null;
	return { promptTokens, cachedTokens };
}

// The first call writes the cache, so only the second says anything about hits.
export function measureRow(ts: number, warm: ProbeResponse, hit: ProbeResponse | null): MeasureRow {
	const speeds = [warm, hit].flatMap((r) => {
		const speed = r && tokensPerSec(r);
		return speed ? [speed] : [];
	});
	return { ts, cache: cacheFigures(hit), speeds };
}

export function addRow(state: MeasureState, row: MeasureRow, now: number): MeasureState {
	return { ...state, rows: [...state.rows.filter((r) => r.ts > now - DAY_MS), row] };
}

export function summarizePerf(measure: MeasureState, seq: number, intervalMin: number, now: number): WatchPerf {
	const rows = measure.rows.filter((r) => r.ts > now - DAY_MS);
	const caches = rows.flatMap((r) => (r.cache ? [r.cache] : []));
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

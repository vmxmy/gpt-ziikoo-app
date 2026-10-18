import type { FailReason, Stat } from "./types.ts";

export type MonitorState = "operational" | "degraded" | "down" | "no_data";

export type MonitorSample = {
	ts: number;
	question: string;
	ok: boolean;
	correct: boolean | null;
	reason: FailReason | null;
	httpStatus: number | null;
	totalMs: number | null;
	ttfbMs: number | null;
	ttftMs: number | null;
};

export type MonitorBucket = {
	start: number;
	state: MonitorState;
	total: number;
	failed: number;
	wrong: number;
	totalMs: Stat | null;
	ttftMs: Stat | null;
};

export type MonitorResponse = {
	target: string;
	intervalSec: number;
	bucketMin: number;
	generatedAt: number;
	configured: boolean;
	state: MonitorState;
	uptimePct: number | null;
	correctPct: number | null;
	last: MonitorSample | null;
	buckets: MonitorBucket[];
};

export const MONITOR = {
	intervalSec: 60,
	bucketMin: 30,
	buckets: 48,
	retentionMs: 7 * 24 * 60 * 60_000,
	staleMs: 10 * 60_000,
	downRatio: 0.2,
	wrongRatio: 0.2,
} as const;

const BUCKET_MS = MONITOR.bucketMin * 60_000;

export function bucketState(c: { total: number; failed: number; wrong: number }): MonitorState {
	if (c.total === 0) return "no_data";
	if (c.failed / c.total >= MONITOR.downRatio) return "down";
	const judged = c.total - c.failed;
	if (c.failed > 0 || (judged > 0 && c.wrong / judged >= MONITOR.wrongRatio)) return "degraded";
	return "operational";
}

function stat(values: number[]): Stat | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
	return { min: sorted[0]!, p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1]! };
}

const numbers = (values: (number | null)[]): number[] => values.filter((v): v is number => v !== null);

function summarizeBucket(start: number, samples: MonitorSample[]): MonitorBucket {
	const valid = samples.filter((s) => s.ok);
	const counts = {
		total: samples.length,
		failed: samples.length - valid.length,
		wrong: valid.filter((s) => s.correct === false).length,
	};
	return {
		start,
		state: bucketState(counts),
		...counts,
		totalMs: stat(numbers(valid.map((s) => s.totalMs))),
		ttftMs: stat(numbers(valid.map((s) => s.ttftMs))),
	};
}

const pct = (part: number, whole: number): number | null => (whole === 0 ? null : (part / whole) * 100);

export function buildMonitor(samples: MonitorSample[], now: number, target: string, configured: boolean): MonitorResponse {
	const end = Math.ceil(now / BUCKET_MS) * BUCKET_MS;
	const first = end - MONITOR.buckets * BUCKET_MS;
	const inWindow = samples.filter((s) => s.ts >= first && s.ts < end);
	const buckets = Array.from({ length: MONITOR.buckets }, (_, i) => {
		const start = first + i * BUCKET_MS;
		return summarizeBucket(start, inWindow.filter((s) => s.ts >= start && s.ts < start + BUCKET_MS));
	});
	const last = inWindow.reduce<MonitorSample | null>((a, s) => (a === null || s.ts > a.ts ? s : a), null);
	const latest = [...buckets].reverse().find((b) => b.total > 0);
	const fresh = last !== null && now - last.ts <= MONITOR.staleMs;
	const valid = inWindow.filter((s) => s.ok);
	const judged = valid.filter((s) => s.correct !== null);
	return {
		target,
		intervalSec: MONITOR.intervalSec,
		bucketMin: MONITOR.bucketMin,
		generatedAt: now,
		configured,
		state: fresh && latest ? latest.state : "no_data",
		uptimePct: pct(valid.length, inWindow.length),
		correctPct: pct(judged.filter((s) => s.correct === true).length, judged.length),
		last,
		buckets,
	};
}

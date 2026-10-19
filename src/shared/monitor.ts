import type { FailReason, Stat } from "./types.ts";

export type MonitorState = "operational" | "fair" | "quality" | "degraded" | "down" | "insufficient" | "no_data";

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
	windowTotal: number;
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
	windowMin: 60,
	minSamples: 10,
	downRatio: 0.2,
	failRatio: 0.05,
	wrongRatio: 0.2,
	fairRatio: 0.1,
} as const;

const BUCKET_MS = MONITOR.bucketMin * 60_000;
const WINDOW_MS = MONITOR.windowMin * 60_000;

type Counts = { total: number; failed: number; wrong: number };

// A tier needs enough calls behind it; a handful of samples would flip the tier on one bad call.
export function bucketState(c: Counts): MonitorState {
	if (c.total === 0) return "no_data";
	if (c.total < MONITOR.minSamples) return "insufficient";
	const failedRatio = c.failed / c.total;
	if (failedRatio >= MONITOR.downRatio) return "down";
	const judged = c.total - c.failed;
	const wrongRatio = judged > 0 ? c.wrong / judged : 0;
	if (wrongRatio >= MONITOR.wrongRatio) return "quality";
	if (failedRatio >= MONITOR.failRatio) return "degraded";
	return wrongRatio > MONITOR.fairRatio ? "fair" : "operational";
}

function countsOf(samples: MonitorSample[]): Counts {
	const valid = samples.filter((s) => s.ok);
	return { total: samples.length, failed: samples.length - valid.length, wrong: valid.filter((s) => s.correct === false).length };
}

function stat(values: number[]): Stat | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
	return { min: sorted[0]!, p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1]! };
}

const numbers = (values: (number | null)[]): number[] => values.filter((v): v is number => v !== null);

// The counts describe the half hour itself. The tier comes from the trailing window ending at its close,
// so a half hour of about 30 calls does not decide it alone.
function summarizeBucket(start: number, samples: MonitorSample[], windowSamples: MonitorSample[]): MonitorBucket {
	const valid = samples.filter((s) => s.ok);
	return {
		start,
		state: samples.length === 0 ? "no_data" : bucketState(countsOf(windowSamples)),
		windowTotal: windowSamples.length,
		...countsOf(samples),
		totalMs: stat(numbers(valid.map((s) => s.totalMs))),
		ttftMs: stat(numbers(valid.map((s) => s.ttftMs))),
	};
}

const pct = (part: number, whole: number): number | null => (whole === 0 ? null : (part / whole) * 100);

export function buildMonitor(samples: MonitorSample[], now: number, target: string): MonitorResponse {
	const end = Math.ceil(now / BUCKET_MS) * BUCKET_MS;
	const first = end - MONITOR.buckets * BUCKET_MS;
	const pool = samples.filter((s) => s.ts >= first - WINDOW_MS && s.ts < end);
	const inWindow = pool.filter((s) => s.ts >= first);
	const buckets = Array.from({ length: MONITOR.buckets }, (_, i) => {
		const start = first + i * BUCKET_MS;
		const close = start + BUCKET_MS;
		return summarizeBucket(
			start,
			inWindow.filter((s) => s.ts >= start && s.ts < close),
			pool.filter((s) => s.ts >= close - WINDOW_MS && s.ts < close),
		);
	});
	const last = inWindow.reduce<MonitorSample | null>((a, s) => (a === null || s.ts > a.ts ? s : a), null);
	const fresh = last !== null && now - last.ts <= MONITOR.staleMs;
	const valid = inWindow.filter((s) => s.ok);
	const judged = valid.filter((s) => s.correct !== null);
	return {
		target,
		intervalSec: MONITOR.intervalSec,
		bucketMin: MONITOR.bucketMin,
		generatedAt: now,
		state: fresh ? bucketState(countsOf(pool.filter((s) => s.ts > now - WINDOW_MS && s.ts <= now))) : "no_data",
		uptimePct: pct(valid.length, inWindow.length),
		correctPct: pct(judged.filter((s) => s.correct === true).length, judged.length),
		last,
		buckets,
	};
}

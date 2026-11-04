import { freshHit } from "./cache-hit.ts";
import type { ProbeOk, ProbeResponse } from "./types.ts";

export const PERF_QPS = [0.5, 1] as const;
export const PERF_DURATIONS = [30, 60] as const;

export type PerfConfig = { qps: (typeof PERF_QPS)[number]; durationSec: (typeof PERF_DURATIONS)[number] };
// sentAt and returnedAt come from the browser clock, so the window spans the whole round trip of every call.
export type PerfSample = { sentAt: number; returnedAt: number; response: ProbeResponse | null };
export type PerfCriterion = {
	id: "cache" | "success" | "ttft" | "tpot" | "tpm";
	verdict: "pass" | "fail" | "na";
	value: number | null;
	threshold: number;
	note: string;
};
export type PerfStats = { avg: number | null; p50: number | null; p90: number | null };
export type PerfSummary = {
	requestCount: number;
	successCount: number;
	successRate: number;
	windowMs: number;
	rpm: number;
	inputTpm: number | null;
	outputTpm: number | null;
	totalTpm: number | null;
	cachedTpm: number | null;
	cacheHitRate: number | null;
	latencyMs: PerfStats;
	ttftMs: PerfStats;
	tpotMs: PerfStats;
	maxLatencyMs: number | null;
	promptTokensMedian: number | null;
	criteria: PerfCriterion[];
	verdict: "pass" | "fail";
};

export const PERF_THRESHOLDS = { cache: 0.9, success: 0.99, ttft: 20_000, tpot: 30, tpm: 5_000_000 } as const;

const MINUTE_MS = 60_000;

export function sendOffsets({ qps, durationSec }: PerfConfig): number[] {
	return Array.from({ length: qps * durationSec }, (_, i) => (i * 1000) / qps);
}

// Nearest rank: the smallest sample with at least p of the samples at or below it.
function stats(values: number[]): PerfStats {
	if (values.length === 0) return { avg: null, p50: null, p90: null };
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
	return { avg: values.reduce((sum, v) => sum + v, 0) / values.length, p50: rank(0.5), p90: rank(0.9) };
}

function perMinute(values: (number | null)[], windowMs: number): number | null {
	const known = values.filter((v) => v !== null);
	return known.length === 0 || windowMs <= 0 ? null : (known.reduce((sum, v) => sum + v, 0) * MINUTE_MS) / windowMs;
}

// Reasoning comes before the first answer token, so only answer tokens share the time after it.
function tpot(r: ProbeOk): number | null {
	if (r.ttftMs === null || r.outputTokens === null) return null;
	const answer = r.outputTokens - (r.reasoningTokens ?? 0);
	return answer < 2 ? null : (r.totalMs - r.ttftMs) / (answer - 1);
}

function atLeast(id: "cache" | "success", value: number | null, note: string): PerfCriterion {
	const threshold = PERF_THRESHOLDS[id];
	return { id, verdict: value !== null && value >= threshold ? "pass" : "fail", value, threshold, note };
}

function below(id: "ttft" | "tpot", value: number | null, note: string): PerfCriterion {
	const threshold = PERF_THRESHOLDS[id];
	return { id, verdict: value !== null && value < threshold ? "pass" : "fail", value, threshold, note };
}

function criteria(s: Omit<PerfSummary, "criteria" | "verdict">): PerfCriterion[] {
	const noData = "没有有效数据";
	return [
		atLeast("cache", s.cacheHitRate, s.cacheHitRate === null ? "预热或发压调用没有可用的缓存用量" : "以预热为第 1 次，汇总各次的新鲜命中"),
		atLeast("success", s.requestCount === 0 ? null : s.successRate, s.requestCount === 0 ? noData : `${s.successCount} / ${s.requestCount}`),
		below("ttft", s.ttftMs.p90, s.ttftMs.p90 === null ? noData : ""),
		below("tpot", s.tpotMs.p90, s.tpotMs.p90 === null ? noData : ""),
		{ id: "tpm", verdict: "na", value: s.totalTpm, threshold: PERF_THRESHOLDS.tpm, note: "本站只有探测档，不判定 TPM" },
	];
}

export function summarizeLoad(warm: ProbeResponse | null, samples: PerfSample[], _config: PerfConfig): PerfSummary {
	const oks = samples.flatMap((s) => (s.response?.ok ? [s.response] : []));
	const windowMs = samples.length === 0 ? 0 : Math.max(...samples.map((s) => s.returnedAt)) - Math.min(...samples.map((s) => s.sentAt));
	const inputTpm = perMinute(oks.map((r) => r.promptTokens), windowMs);
	const outputTpm = perMinute(oks.map((r) => r.outputTokens), windowMs);
	const hits = samples.flatMap((s) => {
		const hit = freshHit(warm, s.response);
		return hit ? [hit] : [];
	});
	const fresh = hits.reduce((sum, h) => sum + h.promptTokens, 0);
	const latencies = oks.map((r) => r.totalMs);
	const summary = {
		requestCount: samples.length,
		successCount: oks.length,
		successRate: samples.length === 0 ? 0 : oks.length / samples.length,
		windowMs,
		rpm: windowMs > 0 ? (samples.length * MINUTE_MS) / windowMs : 0,
		inputTpm,
		outputTpm,
		totalTpm: inputTpm === null || outputTpm === null ? null : inputTpm + outputTpm,
		cachedTpm: perMinute(oks.map((r) => r.cachedTokens), windowMs),
		cacheHitRate: fresh === 0 ? null : hits.reduce((sum, h) => sum + h.cachedTokens, 0) / fresh,
		latencyMs: stats(latencies),
		ttftMs: stats(oks.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs]))),
		tpotMs: stats(oks.flatMap((r) => tpot(r) ?? [])),
		maxLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
		promptTokensMedian: stats(oks.flatMap((r) => (r.promptTokens === null ? [] : [r.promptTokens]))).p50,
	};
	const list = criteria(summary);
	return { ...summary, criteria: list, verdict: list.every((c) => c.verdict !== "fail") ? "pass" : "fail" };
}

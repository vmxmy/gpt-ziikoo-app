import type { ProbeResponse } from "./types.ts";

export const PERF_QPS = [0.5, 1] as const;
export const PERF_DURATIONS = [30, 60] as const;

export type PerfConfig = { qps: (typeof PERF_QPS)[number]; durationSec: (typeof PERF_DURATIONS)[number] };
export type PerfSample = { sentAt: number; response: ProbeResponse | null };
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

export function sendOffsets(_config: PerfConfig): number[] {
	throw new Error("not implemented");
}

export function summarizeLoad(_warm: ProbeResponse | null, _samples: PerfSample[], _config: PerfConfig): PerfSummary {
	throw new Error("not implemented");
}

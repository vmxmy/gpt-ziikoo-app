import { describe, expect, it } from "vitest";
import { sendOffsets, summarizeLoad, type PerfSample } from "./perf.ts";
import type { ProbeOk } from "./types.ts";

type Usage = { prompt: number; cached: number; output: number; reasoning: number | null; ttft: number; total: number };

const ok = ({ prompt, cached, output, reasoning, ttft, total }: Usage): ProbeOk => ({
	ok: true,
	questionVersion: 2,
	correct: null,
	note: "unscored",
	reasoningTokens: reasoning,
	outputTokens: output,
	idShape: "hex",
	answer: "1",
	streamed: true,
	ttfbMs: 100,
	ttftMs: ttft,
	totalMs: total,
	promptTokens: prompt,
	cachedTokens: cached,
});

const WARM = ok({ prompt: 10_000, cached: 0, output: 300, reasoning: 0, ttft: 1000, total: 5000 });
const CONFIG = { qps: 1, durationSec: 30 } as const;

const SAMPLES: PerfSample[] = [
	{ sentAt: 1000, returnedAt: 7000, response: ok({ prompt: 10_000, cached: 9500, output: 300, reasoning: 100, ttft: 2000, total: 6000 }) },
	{ sentAt: 2000, returnedAt: 5000, response: ok({ prompt: 10_000, cached: 9000, output: 101, reasoning: null, ttft: 1000, total: 3000 }) },
	{ sentAt: 3000, returnedAt: 7000, response: ok({ prompt: 10_000, cached: 10_000, output: 1, reasoning: 0, ttft: 500, total: 4000 }) },
	{ sentAt: 4000, returnedAt: 5000, response: null },
];

describe("sendOffsets", () => {
	it("spaces calls by the rate without waiting for answers", () => {
		expect(sendOffsets({ qps: 1, durationSec: 30 })).toEqual(Array.from({ length: 30 }, (_, i) => i * 1000));
		expect(sendOffsets({ qps: 0.5, durationSec: 60 })).toEqual(Array.from({ length: 30 }, (_, i) => i * 2000));
	});
});

describe("summarizeLoad", () => {
	it("summarizes a load run against the five criteria", () => {
		const s = summarizeLoad(WARM, SAMPLES, CONFIG);
		expect(s).toMatchObject({ requestCount: 4, successCount: 3, successRate: 0.75, windowMs: 6000, rpm: 40 });
		expect(s).toMatchObject({ inputTpm: 300_000, outputTpm: 4020, totalTpm: 304_020, cachedTpm: 285_000, cacheHitRate: 0.95 });
		expect(s.latencyMs).toEqual({ avg: 13_000 / 3, p50: 4000, p90: 6000 });
		expect(s.ttftMs).toEqual({ avg: 3500 / 3, p50: 1000, p90: 2000 });
		expect(s.tpotMs).toEqual({ avg: (20 + 4000 / 199) / 2, p50: 20, p90: 4000 / 199 });
		expect(s).toMatchObject({ maxLatencyMs: 6000, promptTokensMedian: 10_000 });
		expect(s.criteria.map(({ id, verdict, value, threshold }) => ({ id, verdict, value, threshold }))).toEqual([
			{ id: "cache", verdict: "pass", value: 0.95, threshold: 0.9 },
			{ id: "success", verdict: "fail", value: 0.75, threshold: 0.99 },
			{ id: "ttft", verdict: "pass", value: 2000, threshold: 20_000 },
			{ id: "tpot", verdict: "pass", value: 4000 / 199, threshold: 30 },
			{ id: "tpm", verdict: "na", value: 304_020, threshold: 5_000_000 },
		]);
		expect(s.verdict).toBe("fail");
		expect(summarizeLoad(WARM, SAMPLES.slice(0, 3), CONFIG).verdict).toBe("pass");
	});

	it("ends the window at the last return, failed calls included", () => {
		const late: PerfSample[] = [
			{ sentAt: 0, returnedAt: 1000, response: ok({ prompt: 10_000, cached: 0, output: 10, reasoning: 0, ttft: 500, total: 900 }) },
			{ sentAt: 1000, returnedAt: 121_000, response: null },
		];
		expect(summarizeLoad(WARM, late, CONFIG)).toMatchObject({ windowMs: 121_000, rpm: 120_000 / 121_000, inputTpm: 600_000_000 / 121_000 });
	});

	it("never passes a criterion it has no data for", () => {
		const s = summarizeLoad(null, SAMPLES.slice(0, 3), CONFIG);
		expect(s.cacheHitRate).toBeNull();
		expect(s.criteria.find((c) => c.id === "cache")).toMatchObject({ verdict: "fail", value: null });
		expect(s.verdict).toBe("fail");
		const empty = summarizeLoad(WARM, [{ sentAt: 0, returnedAt: 100, response: null }], CONFIG);
		expect(empty.criteria.map((c) => c.verdict)).toEqual(["fail", "fail", "fail", "fail", "na"]);
		expect(empty).toMatchObject({ inputTpm: null, totalTpm: null, maxLatencyMs: null, latencyMs: { avg: null, p50: null, p90: null } });
	});
});

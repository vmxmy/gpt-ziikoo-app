import { describe, expect, it } from "vitest";
import { MONITOR, bucketState, buildMonitor, type MonitorSample } from "./monitor.ts";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const sample = (minutesAgo: number, over: Partial<MonitorSample> = {}): MonitorSample => ({
	ts: NOW - minutesAgo * MIN,
	question: "thibault",
	ok: true,
	correct: true,
	reason: null,
	httpStatus: 200,
	totalMs: 1000,
	ttfbMs: 300,
	ttftMs: 600,
	...over,
});

describe("bucketState", () => {
	it("is no_data for an empty window", () => {
		expect(bucketState({ total: 0, failed: 0, wrong: 0 })).toBe("no_data");
	});

	it("gives no tier below the minimum sample count, even when every call failed", () => {
		expect(bucketState({ total: MONITOR.minSamples - 1, failed: MONITOR.minSamples - 1, wrong: 0 })).toBe("insufficient");
	});

	it("does not flip on a single wrong answer among 15", () => {
		expect(bucketState({ total: 15, failed: 0, wrong: 1 })).toBe("operational");
	});

	it("splits a clean window at 90% correct, keeping exactly 90% in the top tier", () => {
		expect(bucketState({ total: 30, failed: 0, wrong: 3 })).toBe("operational");
		expect(bucketState({ total: 30, failed: 0, wrong: 4 })).toBe("fair");
		expect(bucketState({ total: 10, failed: 0, wrong: 1 })).toBe("operational");
		expect(bucketState({ total: 11, failed: 0, wrong: 2 })).toBe("fair");
	});

	it("tells the causes apart: 5% failed calls is unstable, one fifth wrong answers is quality loss", () => {
		expect(bucketState({ total: 15, failed: 1, wrong: 0 })).toBe("degraded");
		expect(bucketState({ total: 30, failed: 1, wrong: 0 })).toBe("operational");
		expect(bucketState({ total: 15, failed: 0, wrong: 3 })).toBe("quality");
		expect(bucketState({ total: 20, failed: 1, wrong: 4 })).toBe("quality");
	});

	it("is down when one fifth of the calls failed", () => {
		expect(bucketState({ total: 15, failed: 3, wrong: 0 })).toBe("down");
	});
});

describe("buildMonitor", () => {
	it("always returns 48 half-hour buckets aligned to the clock", () => {
		const m = buildMonitor([sample(1)], NOW, "relay.example");
		expect(m.buckets).toHaveLength(MONITOR.buckets);
		expect(m.buckets.every((b) => b.start % (MONITOR.bucketMin * MIN) === 0)).toBe(true);
	});

	it("judges the overall state on the last 60 minutes, and no_data once samples are stale", () => {
		const healthy = Array.from({ length: 10 }, (_, i) => sample(i + 1));
		const fresh = buildMonitor([...healthy, sample(12, { ok: false, correct: null, reason: "timeout" })], NOW, "t");
		expect(fresh.state).toBe("degraded");
		expect(buildMonitor([sample(1)], NOW, "t").state).toBe("insufficient");
		expect(buildMonitor([sample(30)], NOW, "t").state).toBe("no_data");
	});

	it("tiers a half hour from the trailing hour, so a thin half hour is not judged alone", () => {
		const earlier = Array.from({ length: 20 }, (_, i) => sample(31 + i));
		const recent = Array.from({ length: 10 }, (_, i) => sample(1 + i, { correct: i >= 4 }));
		const last = buildMonitor([...earlier, ...recent], NOW, "t").buckets.at(-1)!;
		expect(last).toMatchObject({ total: 10, wrong: 4, windowTotal: 30, state: "fair" });
	});

	it("computes uptime and correctness over valid calls and ignores samples outside 24h", () => {
		const samples = [
			sample(1),
			sample(2, { correct: false }),
			sample(3, { ok: false, correct: null, reason: "upstream_error", httpStatus: 502 }),
			sample(25 * 60),
		];
		const m = buildMonitor(samples, NOW, "t");
		expect(m.uptimePct).toBeCloseTo(66.67, 1);
		expect(m.correctPct).toBe(50);
		expect(m.last?.ts).toBe(NOW - MIN);
	});

	it("gives percentile latency per bucket from valid calls only", () => {
		const m = buildMonitor([sample(1, { totalMs: 100 }), sample(2, { totalMs: 300 }), sample(3, { ok: false, totalMs: null })], NOW, "t");
		const bucket = m.buckets.find((b) => b.total > 0)!;
		expect(bucket.totalMs).toEqual({ min: 100, p50: 100, p95: 300, max: 300 });
	});
});

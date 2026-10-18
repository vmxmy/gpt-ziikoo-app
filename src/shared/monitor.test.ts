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
	it("is no_data for an empty bucket", () => {
		expect(bucketState({ total: 0, failed: 0, wrong: 0 })).toBe("no_data");
	});

	it("does not flip on a single wrong answer among 15", () => {
		expect(bucketState({ total: 15, failed: 0, wrong: 1 })).toBe("operational");
	});

	it("is degraded when any call failed or one fifth are wrong", () => {
		expect(bucketState({ total: 15, failed: 1, wrong: 0 })).toBe("degraded");
		expect(bucketState({ total: 15, failed: 0, wrong: 3 })).toBe("degraded");
	});

	it("is down when one fifth of the calls failed", () => {
		expect(bucketState({ total: 15, failed: 3, wrong: 0 })).toBe("down");
	});
});

describe("buildMonitor", () => {
	it("always returns 48 half-hour buckets aligned to the clock", () => {
		const m = buildMonitor([sample(1)], NOW, "gaoxin.net.cn", true);
		expect(m.buckets).toHaveLength(MONITOR.buckets);
		expect(m.buckets.every((b) => b.start % (MONITOR.bucketMin * MIN) === 0)).toBe(true);
	});

	it("passes the configured flag through unchanged", () => {
		expect(buildMonitor([], NOW, "t", false)).toMatchObject({ configured: false, state: "no_data", last: null });
		expect(buildMonitor([], NOW, "t", true).configured).toBe(true);
	});

	it("reports the newest bucket state, and no_data once samples are stale", () => {
		const healthy = Array.from({ length: 10 }, (_, i) => sample(i + 1));
		const fresh = buildMonitor([...healthy, sample(12, { ok: false, correct: null, reason: "timeout" })], NOW, "t", true);
		expect(fresh.state).toBe("degraded");
		const stale = buildMonitor([sample(30)], NOW, "t", true);
		expect(stale.state).toBe("no_data");
	});

	it("computes uptime and correctness over valid calls and ignores samples outside 24h", () => {
		const samples = [
			sample(1),
			sample(2, { correct: false }),
			sample(3, { ok: false, correct: null, reason: "upstream_error", httpStatus: 502 }),
			sample(25 * 60),
		];
		const m = buildMonitor(samples, NOW, "t", true);
		expect(m.uptimePct).toBeCloseTo(66.67, 1);
		expect(m.correctPct).toBe(50);
		expect(m.last?.ts).toBe(NOW - MIN);
	});

	it("gives percentile latency per bucket from valid calls only", () => {
		const m = buildMonitor([sample(1, { totalMs: 100 }), sample(2, { totalMs: 300 }), sample(3, { ok: false, totalMs: null })], NOW, "t", true);
		const bucket = m.buckets.find((b) => b.total > 0)!;
		expect(bucket.totalMs).toEqual({ min: 100, p50: 100, p95: 300, max: 300 });
	});
});

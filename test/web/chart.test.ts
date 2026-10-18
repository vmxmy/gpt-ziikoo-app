import { describe, expect, it } from "vitest";
import type { MonitorBucket } from "../../src/shared/monitor.ts";
import { chartModel, linePath, niceMax, xOf, yOf } from "../../src/web/chart.ts";

const stat = (p50: number) => ({ min: p50, p50, p95: p50, max: p50 });
const bucket = (total: number | null, ttft: number | null): MonitorBucket => ({
	start: 1,
	state: "operational",
	total: 1,
	failed: 0,
	wrong: 0,
	totalMs: total === null ? null : stat(total),
	ttftMs: ttft === null ? null : stat(ttft),
});

describe("monitor chart", () => {
	it("rounds the axis maximum up to 1, 2 or 5 times a power of ten", () => {
		expect(niceMax(1234)).toBe(2000);
		expect(niceMax(4200)).toBe(5000);
		expect(niceMax(800)).toBe(1000);
		expect(niceMax(0)).toBe(1000);
	});

	it("places bucket centres on x and milliseconds on y", () => {
		expect(xOf(0, 4)).toBe(128);
		expect(xOf(3, 4)).toBe(560);
		expect(yOf(0, 400)).toBe(176);
		expect(yOf(400, 400)).toBe(8);
		expect(yOf(100, 400)).toBe(134);
	});

	it("breaks the line at buckets without data", () => {
		expect(linePath([100, null, 200, 300], 400)).toBe("M128.0,134.0M416.0,92.0L560.0,50.0");
		expect(linePath([null, null], 400)).toBe("");
	});

	it("scales both series to one axis", () => {
		const m = chartModel([bucket(1500, 600), bucket(null, null)]);
		expect(m.maxMs).toBe(2000);
		expect(m.totalPath).toBe("M200.0,50.0");
		expect(m.ttftPath).toBe("M200.0,125.6");
		expect(m.ticks.map((t) => t.label)).toEqual(["0", "1000", "2000"]);
	});
});

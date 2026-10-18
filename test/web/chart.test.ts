import { describe, expect, it } from "vitest";
import type { MonitorBucket } from "../../src/shared/monitor.ts";
import { chartModel, formatMs, linePath, niceMax, xOf, xTickIndexes, yOf, yTickValues } from "../../src/web/chart.ts";

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

	it("labels axis values with a unit", () => {
		expect([0, 250, 1000, 1250, 5000].map(formatMs)).toEqual(["0", "250 ms", "1 s", "1.25 s", "5 s"]);
	});

	it("places bucket centres on x for the measured width and milliseconds on y", () => {
		expect(xOf(0, 4, 640)).toBe(120.5);
		expect(xOf(3, 4, 640)).toBe(555.5);
		expect(xOf(0, 4, 360)).toBe(85.5);
		expect(yOf(0, 400)).toBe(112);
		expect(yOf(400, 400)).toBe(12);
		expect(yOf(100, 400)).toBe(87);
	});

	it("breaks the line at buckets without data", () => {
		expect(linePath([100, null, 200, 300], 400, 640)).toBe("M120.5,87.0M410.5,62.0L555.5,37.0");
		expect(linePath([null, null], 400, 640)).toBe("");
	});

	it("scales both series to one axis and marks each series' last point", () => {
		const m = chartModel([bucket(1500, 600), bucket(null, null)], 640);
		expect(m.maxMs).toBe(2000);
		expect(m.totalPath).toBe("M193.0,37.0");
		expect(m.ttftPath).toBe("M193.0,82.0");
		expect(m.totalLast).toEqual({ x: 193, y: 37 });
		expect(m.ttftLast).toEqual({ x: 193, y: 82 });
		expect(m.yTicks.map((t) => t.label)).toEqual(["0", "500 ms", "1 s", "1.5 s", "2 s"]);
		expect(chartModel([bucket(null, null)], 640).totalLast).toBeNull();
	});

	it("keeps y ticks on round values", () => {
		expect(yTickValues(5000)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
		expect(yTickValues(2000)).toEqual([0, 500, 1000, 1500, 2000]);
		expect(yTickValues(1000)).toEqual([0, 250, 500, 750, 1000]);
	});

	it("puts time ticks on quarter marks and the newest bucket", () => {
		expect(xTickIndexes(48)).toEqual([0, 12, 24, 36, 47]);
		expect(xTickIndexes(4)).toEqual([0, 1, 2, 3]);
		expect(xTickIndexes(0)).toEqual([]);
	});
});

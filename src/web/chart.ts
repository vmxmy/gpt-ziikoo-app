import type { MonitorBucket } from "../shared/monitor.ts";

export const CHART = { width: 640, height: 200, left: 56, right: 8, top: 8, bottom: 24 } as const;

export type ChartModel = { totalPath: string; ttftPath: string; maxMs: number; ticks: { y: number; label: string }[] };

const STEPS = [1, 2, 5];

// Rounds up to 1, 2 or 5 times a power of ten so axis ticks land on readable values.
export function niceMax(value: number): number {
	if (value <= 0) return 1000;
	const power = 10 ** Math.floor(Math.log10(value));
	const step = STEPS.find((s) => s * power >= value) ?? 10;
	return step * power;
}

export function xOf(index: number, count: number): number {
	const plot = CHART.width - CHART.left - CHART.right;
	return CHART.left + ((index + 0.5) * plot) / count;
}

export function yOf(value: number, max: number): number {
	const plot = CHART.height - CHART.top - CHART.bottom;
	return CHART.top + plot - (value / max) * plot;
}

export function linePath(values: (number | null)[], max: number): string {
	let path = "";
	let drawing = false;
	values.forEach((v, i) => {
		if (v === null) {
			drawing = false;
			return;
		}
		path += `${drawing ? "L" : "M"}${xOf(i, values.length).toFixed(1)},${yOf(v, max).toFixed(1)}`;
		drawing = true;
	});
	return path;
}

export function chartModel(buckets: MonitorBucket[]): ChartModel {
	const total = buckets.map((b) => b.totalMs?.p50 ?? null);
	const ttft = buckets.map((b) => b.ttftMs?.p50 ?? null);
	const maxMs = niceMax(Math.max(0, ...total.filter((v) => v !== null), ...ttft.filter((v) => v !== null)));
	const ticks = [0, 0.5, 1].map((f) => ({ y: yOf(maxMs * f, maxMs), label: `${maxMs * f}` }));
	return { totalPath: linePath(total, maxMs), ttftPath: linePath(ttft, maxMs), maxMs, ticks };
}

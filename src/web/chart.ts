import type { MonitorBucket } from "../shared/monitor.ts";

export const CHART = { width: 640, height: 140, left: 48, right: 12, top: 12, bottom: 28 } as const;

export type Point = { x: number; y: number };
export type Tick = { pos: number; label: string };

export type ChartModel = {
	totalPath: string;
	ttftPath: string;
	totalLast: Point | null;
	ttftLast: Point | null;
	maxMs: number;
	yTicks: Tick[];
};

const STEPS = [1, 2, 5];

// Rounds up to 1, 2 or 5 times a power of ten so axis ticks land on readable values.
export function niceMax(value: number): number {
	if (value <= 0) return 1000;
	const power = 10 ** Math.floor(Math.log10(value));
	const step = STEPS.find((s) => s * power >= value) ?? 10;
	return step * power;
}

export function formatMs(value: number): string {
	if (value === 0) return "0";
	return value >= 1000 ? `${Number((value / 1000).toFixed(2))} s` : `${Number(value.toFixed(0))} ms`;
}

export function xOf(index: number, count: number, width: number): number {
	const plot = width - CHART.left - CHART.right;
	return CHART.left + ((index + 0.5) * plot) / count;
}

export function yOf(value: number, max: number): number {
	const plot = CHART.height - CHART.top - CHART.bottom;
	return CHART.top + plot - (value / max) * plot;
}

export function linePath(values: (number | null)[], max: number, width: number): string {
	let path = "";
	let drawing = false;
	values.forEach((v, i) => {
		if (v === null) {
			drawing = false;
			return;
		}
		path += `${drawing ? "L" : "M"}${xOf(i, values.length, width).toFixed(1)},${yOf(v, max).toFixed(1)}`;
		drawing = true;
	});
	return path;
}

function lastPoint(values: (number | null)[], max: number, width: number): Point | null {
	const i = values.findLastIndex((v) => v !== null);
	return i < 0 ? null : { x: xOf(i, values.length, width), y: yOf(values[i]!, max) };
}

export function chartModel(buckets: MonitorBucket[], width: number): ChartModel {
	const total = buckets.map((b) => b.totalMs?.p50 ?? null);
	const ttft = buckets.map((b) => b.ttftMs?.p50 ?? null);
	const maxMs = niceMax(Math.max(0, ...total.filter((v) => v !== null), ...ttft.filter((v) => v !== null)));
	return {
		totalPath: linePath(total, maxMs, width),
		ttftPath: linePath(ttft, maxMs, width),
		totalLast: lastPoint(total, maxMs, width),
		ttftLast: lastPoint(ttft, maxMs, width),
		maxMs,
		yTicks: yTickValues(maxMs).map((v) => ({ pos: yOf(v, maxMs), label: formatMs(v) })),
	};
}

// A 5×10^n maximum splits into fifths and the others into quarters, so every tick stays a round number.
export function yTickValues(maxMs: number): number[] {
	const parts = maxMs / 10 ** Math.floor(Math.log10(maxMs)) === 5 ? 5 : 4;
	return Array.from({ length: parts + 1 }, (_, i) => (maxMs * i) / parts);
}

// Quarter marks plus the final bucket, so the newest time is always labelled at the right edge.
export function xTickIndexes(count: number): number[] {
	const step = Math.max(1, Math.round(count / 4));
	const indexes = Array.from({ length: Math.ceil(count / step) }, (_, i) => i * step);
	return count > 0 && indexes.at(-1) !== count - 1 ? [...indexes, count - 1] : indexes;
}

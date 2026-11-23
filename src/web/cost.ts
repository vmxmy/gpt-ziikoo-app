import type { Point } from "./chart.ts";

export type ModelId = "astra" | "dsflash" | "dspro" | "opus55";
type ModelPrice = { name: string; hit: number; miss: number; out: number; asOf: string; note?: string };

export const MODEL_IDS: readonly ModelId[] = ["astra", "dsflash", "dspro", "opus55"];

const DEEPSEEK_PEAK = "这是高峰价，非高峰价减半，比例不变。";

// USD per million tokens. Off-peak, batch and fast-mode pricing scale a whole row by one factor, which leaves every ratio on this page unchanged, so each model keeps one row.
export const PRICES: Record<ModelId, ModelPrice> = {
	astra: { name: "GPT-6 Astra", hit: 1, miss: 10, out: 50, asOf: "2026-09" },
	dsflash: { name: "DeepSeek Flash", hit: 0.006, miss: 0.3, out: 1.2, asOf: "2026-09", note: DEEPSEEK_PEAK },
	dspro: { name: "DeepSeek V4 Pro", hit: 0.044, miss: 1.32, out: 3.96, asOf: "2026-09", note: DEEPSEEK_PEAK },
	opus55: {
		name: "Claude Opus 5.5",
		hit: 0.2,
		miss: 5,
		out: 20,
		asOf: "2026-11",
		note: "未命中输入按 5 分钟缓存写入价计。不写缓存的输入是 $4，1 小时缓存写入是 $8。快速模式、批量和美国数据驻留都是整体倍数，比例不变。",
	},
};

export type Channel = { multiplier: number; hitRate: number };
export type Scenario = { model: ModelId; inputTokens: number; outputTokens: number; ref: Channel; exp: Channel };
export type Cost = { hit: number; miss: number; out: number; total: number };
export type BreakEven = { kind: "never" } | { kind: "always" } | { kind: "already" } | { kind: "below"; hitRate: number };
export type Calc = {
	ref: Cost;
	exp: Cost;
	ratio: number;
	priceRatio: number;
	hitFactor: number;
	discountEaten: number | null;
	breakEven: BreakEven;
};

export const DEFAULT_SCENARIO: Scenario = {
	model: "dsflash",
	inputTokens: 100_000,
	outputTokens: 500,
	ref: { multiplier: 1, hitRate: 0.97 },
	exp: { multiplier: 0.1, hitRate: 0.82 },
};

const PER_MILLION = 1_000_000;

function bill(s: Scenario, channel: Channel): Cost {
	const price = PRICES[s.model];
	const scale = channel.multiplier / PER_MILLION;
	const hit = s.inputTokens * channel.hitRate * price.hit * scale;
	const miss = s.inputTokens * (1 - channel.hitRate) * price.miss * scale;
	const out = s.outputTokens * price.out * scale;
	return { hit, miss, out, total: hit + miss + out };
}

// The experiment hit rate at which both bills are equal, for an experiment multiplier. Not clamped.
function criticalHitRate(s: Scenario, expMultiplier: number): number {
	const price = PRICES[s.model];
	const full = (s.inputTokens * price.miss + s.outputTokens * price.out) / PER_MILLION;
	const span = (s.inputTokens * (price.miss - price.hit)) / PER_MILLION;
	return (full - bill(s, s.ref).total / expMultiplier) / span;
}

// Branches on which bill is higher, not on the critical rate against the current one: with equal bills, rounding can put the two a hair apart in either direction.
function classify(critical: number, dearer: boolean): BreakEven {
	if (dearer) return critical > 1 ? { kind: "always" } : { kind: "already" };
	return critical < 0 ? { kind: "never" } : { kind: "below", hitRate: critical };
}

export function calc(s: Scenario): Calc {
	const ref = bill(s, s.ref);
	const exp = bill(s, s.exp);
	const ratio = exp.total / ref.total;
	const priceRatio = s.exp.multiplier / s.ref.multiplier;
	const hitFactor = bill(s, { multiplier: 1, hitRate: s.exp.hitRate }).total / bill(s, { multiplier: 1, hitRate: s.ref.hitRate }).total;
	const eaten = priceRatio < 1 && s.exp.hitRate < s.ref.hitRate;
	return {
		ref,
		exp,
		ratio,
		priceRatio,
		hitFactor,
		discountEaten: eaten ? (ratio - priceRatio) / (1 - priceRatio) : null,
		breakEven: classify(criticalHitRate(s, s.exp.multiplier), ratio > 1),
	};
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

function usd(v: number): string {
	if (v === 0) return "$0";
	if (v >= 1) return `$${v.toFixed(2)}`;
	return v >= 0.01 ? `$${v.toFixed(3)}` : `$${Number(v.toPrecision(2))}`;
}

const QUOTED_CALLS = 1000;

export const perThousand = (v: number): string => usd(v * QUOTED_CALLS);

export const SERIES = ["hit", "miss", "out"] as const;
export type Series = (typeof SERIES)[number];
type Segment = { series: Series; start: number; share: number };

// Shares of `max`, so bars drawn against the same `max` share one scale.
export function barSegments(c: Cost, max: number): Segment[] {
	return SERIES.map((series, i) => ({
		series,
		start: SERIES.slice(0, i).reduce((sum, k) => sum + c[k], 0) / max,
		share: c[series] / max,
	}));
}

export const CURVE = { height: 240, left: 44, right: 12, top: 12, bottom: 32, minMultiplier: 0.05, maxMultiplier: 2 } as const;

const CURVE_STEPS = 40;
const CURVE_RANGE = CURVE.maxMultiplier / CURVE.minMultiplier;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Log scale: discounts sit between 0.05 and 0.5, which a linear axis squeezes into its first quarter.
export function curveX(multiplier: number, width: number): number {
	const plot = width - CURVE.left - CURVE.right;
	return CURVE.left + (Math.log(multiplier / CURVE.minMultiplier) / Math.log(CURVE_RANGE)) * plot;
}

export function curveY(hitRate: number): number {
	const plot = CURVE.height - CURVE.top - CURVE.bottom;
	return CURVE.top + plot - hitRate * plot;
}

export function curvePoints(s: Scenario): Channel[] {
	return Array.from({ length: CURVE_STEPS + 1 }, (_, i) => {
		const multiplier = CURVE.minMultiplier * CURVE_RANGE ** (i / CURVE_STEPS);
		return { multiplier, hitRate: clamp01(criticalHitRate(s, multiplier)) };
	});
}

export function curvePath(s: Scenario, width: number): string {
	return curvePoints(s)
		.map((p, i) => `${i === 0 ? "M" : "L"}${curveX(p.multiplier, width).toFixed(1)},${curveY(p.hitRate).toFixed(1)}`)
		.join("");
}

export function curveMarker(s: Scenario, width: number): Point {
	return { x: curveX(s.exp.multiplier, width), y: curveY(s.exp.hitRate) };
}

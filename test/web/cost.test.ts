import { describe, expect, it } from "vitest";
import { calc, curvePoints, DEFAULT_SCENARIO } from "../../src/web/cost.ts";

describe("discount accounting", () => {
	it("prices the default scenario per call and finds the break-even hit rate", () => {
		const r = calc(DEFAULT_SCENARIO);
		expect(r.ref.total).toBeCloseTo(0.002082, 9);
		expect(r.exp.total).toBeCloseTo(0.0006492, 9);
		expect(r.ratio).toBeCloseTo(0.3118, 3);
		expect(r.priceRatio).toBeCloseTo(0.1, 9);
		expect(r.hitFactor).toBeCloseTo(3.118, 3);
		expect(r.discountEaten).toBeCloseTo(0.2354, 3);
		expect(r.breakEven).toEqual({ kind: "below", hitRate: expect.closeTo(0.3327, 3) });
	});

	it("prices Claude Opus 5.5 with the 5-minute cache write as the miss price", () => {
		const r = calc({ ...DEFAULT_SCENARIO, model: "opus55" });
		expect(r.ref.total).toBeCloseTo(0.0444, 9);
		expect(r.exp.total).toBeCloseTo(0.01164, 9);
		expect(r.ratio).toBeCloseTo(0.2622, 3);
		expect(r.hitFactor).toBeCloseTo(2.622, 3);
		expect(r.breakEven).toEqual({ kind: "below", hitRate: expect.closeTo(0.1375, 9) });
	});

	it("names the outcome when the break-even point is off the scale, and never calls equal bills dearer", () => {
		const cheap = calc({ ...DEFAULT_SCENARIO, exp: { multiplier: 0.05, hitRate: 0.5 } });
		const dear = calc({ ...DEFAULT_SCENARIO, exp: { multiplier: 2, hitRate: 0.82 } });
		const equal = calc({ ...DEFAULT_SCENARIO, exp: DEFAULT_SCENARIO.ref });
		const curve = curvePoints(DEFAULT_SCENARIO);
		expect(cheap.breakEven).toEqual({ kind: "never" });
		expect(dear.breakEven).toEqual({ kind: "always" });
		expect(equal.ratio).toBe(1);
		expect(equal.breakEven).toEqual({ kind: "below", hitRate: expect.closeTo(0.97, 9) });
		expect(curve[0]).toEqual({ multiplier: 0.05, hitRate: 0 });
		expect(curve.at(-1)).toEqual({ multiplier: 2, hitRate: 1 });
	});
});

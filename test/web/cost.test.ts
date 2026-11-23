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

	it("names the outcome instead of a hit rate when the break-even point falls outside 0 to 100%", () => {
		const cheap = calc({ ...DEFAULT_SCENARIO, exp: { multiplier: 0.05, hitRate: 0.5 } });
		const dear = calc({ ...DEFAULT_SCENARIO, exp: { multiplier: 2, hitRate: 0.82 } });
		const curve = curvePoints(DEFAULT_SCENARIO);
		expect(cheap.breakEven).toEqual({ kind: "never" });
		expect(dear.breakEven).toEqual({ kind: "always" });
		expect(curve[0]).toEqual({ multiplier: 0.05, hitRate: 0 });
		expect(curve.at(-1)).toEqual({ multiplier: 2, hitRate: 1 });
	});
});

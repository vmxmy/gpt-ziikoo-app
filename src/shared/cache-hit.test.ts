import { describe, expect, it } from "vitest";
import { freshHit } from "./cache-hit.ts";
import type { ProbeOk, ProbeResponse } from "./types.ts";

const ok = (promptTokens: number | null, cachedTokens: number | null): ProbeOk => ({
	ok: true,
	questionVersion: 2,
	correct: null,
	note: "unscored",
	reasoningTokens: null,
	outputTokens: 300,
	idShape: "hex",
	answer: "1",
	streamed: true,
	ttfbMs: 100,
	ttftMs: 1000,
	totalMs: 3000,
	promptTokens,
	cachedTokens,
});

describe("freshHit", () => {
	it("counts the first call's uncached input that the second call no longer sends uncached", () => {
		expect(freshHit(ok(22_000, 17_000), ok(22_000, 22_000))).toEqual({ promptTokens: 5000, cachedTokens: 5000 });
		expect(freshHit(ok(20_216, 14_946), ok(28_761, 23_967))).toEqual({ promptTokens: 5270, cachedTokens: 476 });
	});

	it("keeps zero hits when the second call sends the same or more uncached input", () => {
		expect(freshHit(ok(5000, 0), ok(5000, 0))).toEqual({ promptTokens: 5000, cachedTokens: 0 });
		expect(freshHit(ok(22_013, 17_687), ok(23_068, 17_916))).toEqual({ promptTokens: 4326, cachedTokens: 0 });
	});

	it("requires at least 4096 uncached tokens in the first call", () => {
		expect(freshHit(ok(5000, 905), ok(5000, 5000))).toBeNull();
		expect(freshHit(ok(5000, 904), ok(5000, 5000))).toEqual({ promptTokens: 4096, cachedTokens: 4096 });
	});

	it.each<ProbeResponse | null>([null, { ok: false, reason: "timeout", httpStatus: null }])("requires two successful responses: %j", (missing) => {
		expect(freshHit(missing, ok(5000, 0))).toBeNull();
		expect(freshHit(ok(5000, 0), missing)).toBeNull();
	});

	it.each([null, -1, 1.5, NaN, Infinity, 10_000_001])("rejects invalid token counts on either call: %s", (invalid) => {
		for (const response of [ok(invalid, 0), ok(5000, invalid)]) {
			expect(freshHit(response, ok(5000, 0))).toBeNull();
			expect(freshHit(ok(5000, 0), response)).toBeNull();
		}
	});

	it("rejects cached counts above the input and accepts the largest valid input", () => {
		expect(freshHit(ok(5000, 5001), ok(5000, 0))).toBeNull();
		expect(freshHit(ok(5000, 0), ok(5000, 5001))).toBeNull();
		expect(freshHit(ok(10_000_000, 0), ok(10_000_000, 10_000_000))).toEqual({ promptTokens: 10_000_000, cachedTokens: 10_000_000 });
	});
});

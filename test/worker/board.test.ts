import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { mergeTokens } = await import("../../src/worker/board.ts");

describe("mergeTokens", () => {
	it("merges and deduplicates tokens", () => {
		expect(mergeTokens(["a", "b"], ["b", "c"], 10)).toEqual(["a", "b", "c"]);
		expect(mergeTokens(["x"], ["x"], 10)).toEqual(["x"]);
		expect(mergeTokens([], ["a", "b"], 10)).toEqual(["a", "b"]);
	});

	it("returns null when the merged list exceeds the max", () => {
		expect(mergeTokens(["a", "b"], ["c", "d"], 3)).toEqual(null);
		expect(mergeTokens(["a", "b", "c"], ["d"], 3)).toEqual(null);
	});

	it("accepts the result at exactly the max", () => {
		expect(mergeTokens(["a", "b"], ["c"], 3)).toEqual(["a", "b", "c"]);
	});
});

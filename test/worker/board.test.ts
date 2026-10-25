import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { mergeTokens, reorderTokens } = await import("../../src/worker/board.ts");

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

describe("reorderTokens", () => {
	it("returns the incoming order for a permutation of the same set", () => {
		expect(reorderTokens(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
		expect(reorderTokens(["a"], ["a"])).toEqual(["a"]);
	});

	it("returns null when a token is missing, extra, or duplicated", () => {
		expect(reorderTokens(["a", "b", "c"], ["a", "b"])).toEqual(null);
		expect(reorderTokens(["a", "b"], ["a", "b", "c"])).toEqual(null);
		expect(reorderTokens(["a", "b"], ["a", "a"])).toEqual(null);
		expect(reorderTokens(["a", "b"], ["a", "x"])).toEqual(null);
	});
});

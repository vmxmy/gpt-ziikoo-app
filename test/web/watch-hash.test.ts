import { describe, expect, it } from "vitest";
import { parseBoardHash } from "../../src/web/watch.ts";

describe("parseBoardHash", () => {
	it("extracts a valid board code from the hash", () => {
		expect(parseBoardHash("#watch/b=AbCdEfGhIjKlMnOpQrSt12")).toBe("AbCdEfGhIjKlMnOpQrSt12");
		expect(parseBoardHash("#watch/b=AAAAAAAAAAAAAAAAAAAAAA")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
	});

	it("returns null for invalid hashes", () => {
		expect(parseBoardHash("#watch")).toBe(null);
		expect(parseBoardHash("#watch/b=short")).toBe(null);
		expect(parseBoardHash("#watch/b=TooLongBoardCodeXXXXXXXX")).toBe(null);
		expect(parseBoardHash("#live")).toBe(null);
		expect(parseBoardHash("")).toBe(null);
	});
});

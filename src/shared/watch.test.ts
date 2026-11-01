import { describe, expect, it } from "vitest";
import { dailyCalls, matchStrategy } from "./watch.ts";

describe("matchStrategy", () => {
	it("finds the strategy with the same interval and questions in any order", () => {
		expect(matchStrategy({ intervalMin: 5, questions: ["ciallo", "thibault", "candy-var", "candy"] })?.id).toBe("authenticity");
		expect(matchStrategy({ intervalMin: 30, questions: ["candy-var", "thibault"] })?.id).toBe("saver");
		expect(matchStrategy({ intervalMin: 1, questions: ["thibault"] })?.id).toBe("line");
	});

	it("finds none for another interval, another question set, or a retired interval", () => {
		expect(matchStrategy({ intervalMin: 5, questions: ["thibault"] })).toBeUndefined();
		expect(matchStrategy({ intervalMin: 30, questions: ["thibault", "candy"] })).toBeUndefined();
		expect(matchStrategy({ intervalMin: 15, questions: ["candy-var", "thibault"] })).toBeUndefined();
	});
});

describe("dailyCalls", () => {
	it("counts one call a round", () => {
		expect([1, 5, 30, 15].map(dailyCalls)).toEqual([1440, 288, 48, 96]);
	});
});

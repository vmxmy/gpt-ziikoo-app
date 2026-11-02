import { describe, expect, it } from "vitest";
import { dailyCalls, matchStrategy, measureEveryRounds } from "./watch.ts";

describe("matchStrategy", () => {
	it("finds the strategy with the same interval and questions in any order", () => {
		expect(matchStrategy({ intervalMin: 5, questions: ["ciallo", "thibault", "candy-var", "candy"], measure: false })?.id).toBe("authenticity");
		expect(matchStrategy({ intervalMin: 30, questions: ["candy-var", "thibault"], measure: false })?.id).toBe("saver");
		expect(matchStrategy({ intervalMin: 1, questions: ["thibault"], measure: false })?.id).toBe("line");
		expect(matchStrategy({ intervalMin: 5, questions: ["candy-var", "thibault"], measure: true })?.id).toBe("compare");
	});

	it("finds none for another interval, another question set, or a retired interval", () => {
		expect(matchStrategy({ intervalMin: 5, questions: ["thibault"], measure: false })).toBeUndefined();
		expect(matchStrategy({ intervalMin: 30, questions: ["thibault", "candy"], measure: false })).toBeUndefined();
		expect(matchStrategy({ intervalMin: 15, questions: ["candy-var", "thibault"], measure: false })).toBeUndefined();
		expect(matchStrategy({ intervalMin: 30, questions: ["candy-var", "thibault"], measure: true })).toBeUndefined();
	});
});

describe("dailyCalls", () => {
	it("counts one call a round, plus two for each measurement", () => {
		expect([1, 5, 30, 15].map((intervalMin) => dailyCalls({ intervalMin, measure: false }))).toEqual([1440, 288, 48, 96]);
		expect([1, 5, 30, 15].map((intervalMin) => dailyCalls({ intervalMin, measure: true }))).toEqual([1456, 304, 64, 112]);
	});
});

describe("measureEveryRounds", () => {
	it("derives about three hours from the one interval, including a retired one", () => {
		expect([1, 5, 10, 15, 30].map(measureEveryRounds)).toEqual([180, 36, 18, 12, 6]);
	});
});

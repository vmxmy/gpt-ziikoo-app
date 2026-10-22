/// <reference types="vite/client" />
import { expect, it } from "vitest";
import { activeQuestions, getQuestion, instantiate, QUESTIONS } from "../../questions/index.ts";

it("registers exactly the directories under questions/", () => {
	const files = Object.keys(import.meta.glob("../../questions/*/*"));
	const dirs = new Set(files.map((path) => path.split("/").at(-2)));
	expect([...dirs].sort()).toEqual(QUESTIONS.map((q) => q.id).sort());
});

it("has unique ids and a scorer on every scored question", () => {
	const ids = QUESTIONS.map((q) => q.id);
	expect(new Set(ids).size).toBe(ids.length);
	expect(QUESTIONS.filter((q) => q.kind !== "metrics" && !q.scorer)).toEqual([]);
});

it("keeps prompt text byte-for-byte", () => {
	expect(getQuestion("thibault")?.prompt).toBe(
		"don't search the internet, do you know Thibault Sottiaux on X. answer yes or no",
	);
	expect(getQuestion("candy")?.prompt).toContain("形状\t苹果味\t桃子味\t西瓜味\n圆形\t7\t9\t8\n");
});

it("lists only active questions", () => {
	expect(activeQuestions().map((q) => q.id)).toEqual(["thibault", "candy", "candy-var", "ciallo"]);
});

it("keeps the ciallo prompt byte-for-byte", () => {
	expect(getQuestion("ciallo")?.prompt).toBe("ciallo\n");
});

it("instantiates a generator question per seed and leaves fixed questions as they are", () => {
	const thibault = getQuestion("thibault")!;
	const candyVar = getQuestion("candy-var")!;
	expect(instantiate(thibault, 7)).toBe(thibault);
	expect(candyVar).toMatchObject({ generator: "candy", scorer: { type: "final_numbers", expected: ["24", "4", "20"] } });
	expect(candyVar.prompt).toContain("形状\t葡萄味\t橙子味\t柠檬味\n圆形\t5\t3\t12\n");
	const one = instantiate(candyVar, 1);
	expect(one).toMatchObject({ id: "candy-var", version: 1, scorer: { type: "final_numbers", expected: ["25", "6", "19"] } });
	expect(one.prompt).toContain("三种口味的巧克力：榛子味、草莓味、抹茶味");
	expect(instantiate(candyVar, 1).prompt).toBe(one.prompt);
});

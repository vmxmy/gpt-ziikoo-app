/// <reference types="vite/client" />
import { expect, it } from "vitest";
import { activeQuestions, getQuestion, QUESTIONS } from "../../questions/index.ts";

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
	expect(activeQuestions().map((q) => q.id)).toEqual(["thibault", "candy"]);
});

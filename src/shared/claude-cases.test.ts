import { describe, expect, it } from "vitest";
import { CLAUDE_CASES } from "./claude-cases.ts";

describe("Claude cases", () => {
	it("lists the Claude cases in the document order", () => {
		expect(CLAUDE_CASES.map((entry) => entry.id)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "P1", "P2", "P3"]);
	});

	it("describes each case and its pass criterion", () => {
		expect(CLAUDE_CASES[0]).toEqual({
			id: "C1",
			title: "基础对话",
			does: "发送一次非流式对话，要求只回答 OK。",
			expect: "返回 200，包含 type=message、content 与 usage。",
		});
		for (const entry of CLAUDE_CASES) {
			expect(entry.title.trim().length).toBeGreaterThan(0);
			expect(entry.does.trim().length).toBeGreaterThan(0);
			expect(entry.expect.trim().length).toBeGreaterThan(0);
		}
		expect(CLAUDE_CASES[12].expect).toBe("标为未测，不创建异步任务。");
	});
});

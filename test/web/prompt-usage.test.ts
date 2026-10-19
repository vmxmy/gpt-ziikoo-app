import { describe, expect, it } from "vitest";
import { generateCandy } from "../../src/shared/candy-gen.ts";
import type { Protocol, QuestionListItem } from "../../src/shared/types.ts";
import { promptUsage } from "../../src/web/prompt-usage.ts";
import type { Attempt } from "../../src/web/runner.ts";

const SEED = 0;
const VAR_CHARS = 309;

const question = (id: string, prompt: string, generator?: "candy"): QuestionListItem => ({
	id,
	version: 1,
	status: "active",
	title: `题 ${id}`,
	measures: "",
	kind: "reasoning",
	generator,
	expectedLabel: "",
	calibratedModels: [],
	failureHint: "",
	prompt,
});

const THIBAULT = question("thibault", "x".repeat(80));
const CANDY = question("candy", "x".repeat(100));
const CANDY_VAR = question("candy-var", "示例", "candy");

const call = (q: string, promptTokens: number | null, protocol: Protocol = "responses"): Attempt => ({
	question: q,
	protocol,
	runId: "r",
	stage: 1,
	seq: 1,
	attempt: 1,
	done: true,
	response: {
		ok: true,
		questionVersion: 1,
		correct: false,
		note: "",
		reasoningTokens: null,
		idShape: "other",
		answer: "",
		streamed: true,
		ttfbMs: 1,
		ttftMs: 1,
		totalMs: 2,
		promptTokens,
		cachedTokens: null,
	},
});

describe("promptUsage", () => {
	it("takes the median of usable calls and skips null usage and failures", () => {
		const failed: Attempt = { ...call("thibault", null), response: { ok: false, reason: "timeout", httpStatus: null } };
		const attempts = [call("thibault", 30), call("thibault", 41), call("thibault", null), failed, call("thibault", 20), call("thibault", 35)];
		expect(promptUsage(attempts, [THIBAULT, CANDY], SEED, "responses")).toEqual({
			rows: [
				{ question: "thibault", title: "题 thibault", chars: 80, calls: 4, medianTokens: 32.5, perChar: 32.5 / 80 },
				{ question: "candy", title: "题 candy", chars: 100, calls: 0, medianTokens: null, perChar: null },
			],
			findings: [],
		});
	});

	it("reports global overhead only above 50 thibault tokens", () => {
		expect(promptUsage([call("thibault", 50)], [THIBAULT], SEED, "responses").findings).toEqual([]);
		expect(promptUsage([call("thibault", 51)], [THIBAULT], SEED, "responses").findings).toEqual([{ kind: "global", tokens: 51 }]);
	});

	it("counts the generated prompt of the run's seed for candy-var", () => {
		expect(generateCandy(SEED).prompt.length).toBe(VAR_CHARS);
		expect(promptUsage([call("candy-var", 309)], [CANDY_VAR], SEED, "responses").rows[0]).toMatchObject({ chars: 309, perChar: 1 });
	});

	it("reports targeted overhead only when candy exceeds candy-var by more than 25%", () => {
		const run = (candyTokens: number) => promptUsage([call("candy", candyTokens), call("candy-var", VAR_CHARS)], [CANDY, CANDY_VAR], SEED, "responses").findings;
		expect(run(125)).toEqual([]);
		expect(run(126)).toEqual([{ kind: "targeted", percent: 26 }]);
		expect(run(60)).toEqual([]);
	});

	it("gives no targeted finding without a candy-var median", () => {
		expect(promptUsage([call("candy", 500)], [CANDY, CANDY_VAR], SEED, "responses").findings).toEqual([]);
	});

	it("counts only calls on the run's protocol", () => {
		const attempts = [call("thibault", 200, "chat"), call("thibault", 40, "responses")];
		expect(promptUsage(attempts, [THIBAULT], SEED, "responses")).toMatchObject({ rows: [{ calls: 1, medianTokens: 40 }], findings: [] });
		expect(promptUsage(attempts, [THIBAULT], SEED, "chat").findings).toEqual([{ kind: "global", tokens: 200 }]);
	});
});

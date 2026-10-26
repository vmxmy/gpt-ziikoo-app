import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateQuestion } from "../../src/shared/ladder.ts";
import type { ProbeResponse } from "../../src/shared/types.ts";
import { checkCustom, customResult, probeCustom, type CustomDraft } from "../../src/web/api.ts";
import { ladderCalls, RATE_LIMIT_RETRIES, runLadder, type ProbeArgs, type ProbeOutcome } from "../../src/web/runner.ts";
import { raceProtocols } from "../../src/web/watch.ts";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

const okResponse = (correct: boolean): ProbeResponse => ({
	ok: true,
	questionVersion: 1,
	correct,
	note: correct ? "YES" : "NO",
	reasoningTokens: 10,
	idShape: "hex",
	answer: correct ? "Yes" : "No",
	streamed: true,
	ttfbMs: 100,
	ttftMs: 200,
	totalMs: 300,
	promptTokens: 20,
	cachedTokens: 0,
});

const CORRECT: ProbeOutcome = { kind: "response", response: okResponse(true) };
const WRONG: ProbeOutcome = { kind: "response", response: okResponse(false) };
const UPSTREAM_FAIL: ProbeOutcome = { kind: "response", response: { ok: false, reason: "upstream_error", httpStatus: 502 } };
const HANG = "hang" as const;

type Script = (args: ProbeArgs) => ProbeOutcome | typeof HANG;

function scriptedProbe(script: Script) {
	const calls: ProbeArgs[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const probe = async (args: ProbeArgs, signal: AbortSignal): Promise<ProbeOutcome> => {
		calls.push(args);
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			const outcome = script(args);
			if (outcome === HANG) {
				return await new Promise<ProbeOutcome>((_, reject) =>
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
				);
			}
			await new Promise((r) => setTimeout(r, 0));
			return outcome;
		} finally {
			inFlight--;
		}
	};
	return { probe, calls, maxInFlight: () => maxInFlight };
}

const run = (script: Script, opts: { questions?: string[]; model?: string; protocol?: "responses" | "chat"; signal?: AbortSignal } = {}) => {
	const p = scriptedProbe(script);
	const done = runLadder({
		runId: RUN_ID,
		questions: opts.questions ?? ["thibault"],
		probe: p.probe,
		signal: opts.signal ?? new AbortController().signal,
		race: raceProtocols(opts.model ?? "gpt-6-astra"),
		protocol: opts.protocol,
	});
	return { ...p, done };
};

describe("runLadder", () => {
	it("runs all four stages, 31 calls, and passes when every answer is correct", async () => {
		const { done, calls } = run(() => CORRECT, { protocol: "responses" });
		const snap = await done;
		const v = evaluateQuestion(ladderCalls(snap.attempts, "thibault", "responses"));
		expect(calls.length).toBe(31);
		expect(v.status).toBe("passed");
		expect(v.correct).toBe(31);
		expect(snap.finished).toBe(true);
	});

	it("sends runId, stage, seq and attempt with every probe", async () => {
		const { done, calls } = run(() => CORRECT, { protocol: "chat" });
		await done;
		expect(calls[0]).toEqual({ question: "thibault", protocol: "chat", runId: RUN_ID, stage: 1, seq: 1, attempt: 1 });
		expect(calls.filter((c) => c.stage === 2).map((c) => c.seq).sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it("caps in-flight calls per stage at 4", async () => {
		const { done, maxInFlight } = run(() => CORRECT, { protocol: "responses" });
		await done;
		expect(maxInFlight()).toBe(4);
	});

	it("stops the stage as soon as it cannot pass and drops aborted calls", async () => {
		const { done, calls } = run(
			(a) => {
				if (a.stage < 3) return CORRECT;
				return a.seq <= 2 ? WRONG : HANG;
			},
			{ protocol: "responses" },
		);
		const snap = await done;
		const v = evaluateQuestion(ladderCalls(snap.attempts, "thibault", "responses"));
		expect(v.status).toBe("failed");
		expect(v.stage).toBe(3);
		expect(calls.filter((c) => c.stage === 3).map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(snap.attempts.length).toBe(8);
		expect(snap.attempts.every((a) => a.done)).toBe(true);
	});

	it("retries a failed call and counts the valid attempt", async () => {
		const { done, calls } = run((a) => (a.stage === 1 && a.attempt === 1 ? UPSTREAM_FAIL : CORRECT), {
			protocol: "responses",
		});
		const snap = await done;
		expect(calls.filter((c) => c.stage === 1).map((c) => c.attempt)).toEqual([1, 2]);
		expect(evaluateQuestion(ladderCalls(snap.attempts, "thibault", "responses")).status).toBe("passed");
	});

	it("judges unavailable after three failed attempts and stops there", async () => {
		const { done, calls } = run(() => UPSTREAM_FAIL, { protocol: "responses" });
		const snap = await done;
		expect(calls.length).toBe(3);
		expect(evaluateQuestion(ladderCalls(snap.attempts, "thibault", "responses")).status).toBe("unavailable");
	});

	it("cancels in-flight calls and starts no new ones", async () => {
		const ctrl = new AbortController();
		const { done, calls } = run((a) => (a.stage === 1 ? CORRECT : HANG), { protocol: "responses", signal: ctrl.signal });
		while (calls.length < 5) await new Promise((r) => setTimeout(r, 0));
		ctrl.abort();
		const snap = await done;
		expect(calls.length).toBe(5);
		expect(snap.cancelled).toBe(true);
		expect(snap.attempts.length).toBe(1);
		expect(evaluateQuestion(ladderCalls(snap.attempts, "thibault", "responses")).status).toBe("incomplete");
	});

	it("waits out our own 429 and resends the same attempt", async () => {
		let limited = false;
		const { done, calls } = run(
			(a) => {
				if (a.question === "candy" && a.stage === 2 && a.seq === 1 && !limited) {
					limited = true;
					return { kind: "stop", status: 429, message: "请求过于频繁", retryAfterSec: 0.01 };
				}
				return CORRECT;
			},
			{ questions: ["thibault", "candy"], protocol: "responses" },
		);
		const snap = await done;
		expect(snap.stop).toBeNull();
		expect(calls.filter((c) => c.question === "candy" && c.stage === 2 && c.seq === 1).map((c) => c.attempt)).toEqual([1, 1]);
		expect(evaluateQuestion(ladderCalls(snap.attempts, "candy", "responses")).status).toBe("passed");
		expect(evaluateQuestion(ladderCalls(snap.attempts, "thibault", "responses")).status).toBe("passed");
	});

	it("stops the whole run when our own 429 persists past the retries and keeps retryAfterSec", async () => {
		const { done, calls } = run(
			(a) => (a.question === "candy" && a.stage === 2 ? { kind: "stop", status: 429, message: "请求过于频繁", retryAfterSec: 0.01 } : a.stage === 1 ? CORRECT : HANG),
			{ questions: ["thibault", "candy"], protocol: "responses" },
		);
		const snap = await done;
		expect(snap.stop).toEqual({ status: 429, message: "请求过于频繁", retryAfterSec: 0.01 });
		expect(calls.filter((c) => c.question === "candy" && c.stage === 2 && c.seq === 1).length).toBe(1 + RATE_LIMIT_RETRIES);
		expect(snap.attempts.filter((a) => !a.done).length).toBe(0);
		expect(calls.filter((c) => c.stage === 3).length).toBe(0);
	});
});

describe("protocol detection", () => {
	it("races both protocols in stage 1 and uses the one with a valid answer", async () => {
		const { done, calls } = run((a) => (a.protocol === "responses" ? UPSTREAM_FAIL : CORRECT), {
			questions: ["thibault", "candy"],
		});
		const snap = await done;
		expect(snap.protocol).toBe("chat");
		expect(calls.filter((c) => c.stage === 1 && c.question === "thibault").map((c) => c.protocol)).toEqual(["responses", "chat"]);
		expect(calls.filter((c) => !(c.stage === 1 && c.question === "thibault")).every((c) => c.protocol === "chat")).toBe(true);
		expect(calls.length).toBe(2 + 30 + 31);
	});

	it("defaults to responses when both protocols answer", async () => {
		const { done } = run(() => CORRECT);
		expect((await done).protocol).toBe("responses");
	});

	it("races anthropic against chat for a Claude model and keeps anthropic when both answer", async () => {
		const { done, calls } = run(() => CORRECT, { model: "claude-opus-5-5" });
		const snap = await done;
		expect(snap.protocol).toBe("anthropic");
		expect(snap.race).toEqual(["anthropic", "chat"]);
		expect(calls.filter((c) => c.stage === 1 && c.seq === 1).map((c) => c.protocol)).toEqual(["anthropic", "chat"]);
	});

	it("does not start other questions when the race finds no working protocol", async () => {
		const { done, calls } = run(() => UPSTREAM_FAIL, { questions: ["thibault", "candy"] });
		const snap = await done;
		expect(calls.length).toBe(6);
		expect(calls.some((c) => c.question === "candy")).toBe(false);
		expect(evaluateQuestion(ladderCalls(snap.attempts, "thibault", snap.protocol)).status).toBe("unavailable");
	});
});

describe("custom question", () => {
	const draft: CustomDraft = { prompt: "Is 2 even? Answer YES or NO.", scorerType: "yes_no", yesNo: "YES", contains: "" };
	const target = { site: "https://example.com", key: "sk-test-1234" };

	afterEach(() => vi.unstubAllGlobals());

	it("counts the prompt limit in code points and rejects one past it", () => {
		expect(checkCustom({ ...draft, prompt: "😀".repeat(2000) }).ok).toBe(true);
		expect(checkCustom({ ...draft, prompt: "😀".repeat(2001) })).toEqual({
			ok: false,
			error: { field: "prompt", message: "题面最多 2000 个字符，现在 2001 个" },
		});
	});

	it("is incomplete without an error while the contains rule is empty", () => {
		expect(checkCustom({ ...draft, scorerType: "contains", contains: "" })).toEqual({ ok: false, error: null });
		expect(checkCustom({ ...draft, scorerType: "contains", contains: "42" })).toEqual({
			ok: true,
			question: { prompt: draft.prompt, scorer: { type: "contains", expected: "42" } },
		});
	});

	it("sends one probe with the custom object and no ladder fields", async () => {
		const fetch = vi.fn(async (_path: string, _init: RequestInit) => Response.json(okResponse(false)));
		vi.stubGlobal("fetch", fetch);
		const question = { prompt: "p", scorer: { type: "yes_no", expected: "YES" } } as const;
		const outcome = await probeCustom(target, "gpt-6-astra", "chat", question);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({ ...target, model: "gpt-6-astra", protocol: "chat", custom: question });
		expect(customResult(outcome)).toEqual({ state: "wrong", label: "答错", response: okResponse(false) });
	});

	it("maps a dropped connection to the network failure", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});
		const outcome = await probeCustom(target, "gpt-6-astra", "responses", { prompt: "p", scorer: { type: "contains", expected: "x" } });
		expect(customResult(outcome)).toEqual({ state: "fail", label: "失败", reason: "连不上本站接口，检查网络后重新测试" });
	});
});

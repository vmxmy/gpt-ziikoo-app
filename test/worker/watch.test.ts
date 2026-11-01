import { afterEach, describe, expect, it, vi } from "vitest";
import { getQuestion, instantiate } from "../../questions/index.ts";
import type { ProbeCapture } from "../../src/worker/probe.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { addUsage, alarmAfterUpdate, planWatch, probeRound, watchRotation } = await import("../../src/worker/watch.ts");

const NOW = 1_000_000_000_000;

const attempt = (httpStatus: number | null, usage: unknown): ProbeCapture => ({
	streamed: null,
	httpStatus,
	ok: false,
	reason: null,
	correct: null,
	note: null,
	reasoningTokens: null,
	idShape: null,
	ttfbMs: null,
	ttftMs: null,
	totalMs: null,
	promptTokens: null,
	cachedTokens: null,
	truncated: false,
	answer: null,
	usage,
	rawHeaders: null,
	rawBody: null,
	rawEvents: null,
});

describe("addUsage", () => {
	it("sums every attempt of a round onto the existing counts and keeps the start date", () => {
		const existing = { since: 5, calls: 1, unmetered: 0, promptTokens: 10, cachedTokens: 1, outputTokens: 20, reasoningTokens: 2 };
		const openai = { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 20 } };
		const anthropic = { input_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 5, output_tokens: 7 };
		expect(addUsage(existing, [attempt(200, openai), attempt(500, anthropic)], NOW)).toEqual({
			since: 5,
			calls: 3,
			unmetered: 0,
			promptTokens: 165,
			cachedTokens: 71,
			outputTokens: 77,
			reasoningTokens: 22,
		});
	});

	it("marks a possibly billed attempt without usable usage as unmetered and ignores numbers out of range", () => {
		const attempts = [attempt(200, null), attempt(null, null), attempt(401, null), attempt(200, { input_tokens: -5, output_tokens: 1e12 })];
		expect(addUsage(undefined, attempts, NOW)).toEqual({
			since: NOW,
			calls: 4,
			unmetered: 3,
			promptTokens: 0,
			cachedTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
		});
	});
});

describe("probeRound", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("draws a new candy-var from a fresh seed each round and keeps it through the retries", async () => {
		const prompts: unknown[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			prompts.push(JSON.parse(String(init.body)).input);
			return new Response("busy", { status: 500 });
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(crypto, "getRandomValues").mockReturnValueOnce(new Uint32Array([7])).mockReturnValueOnce(new Uint32Array([8]));
		const env = { HOST_LIMITER: { limit: async () => ({ success: true }) } };
		const state = { origin: "https://relay.example", host: "relay.example", protocol: "responses" as const, model: "m", questions: ["candy-var"], seq: 0 };
		const question = getQuestion("candy-var")!;

		await probeRound(env, state, "sk-test-12345678");
		expect(prompts).toEqual(Array(4).fill(instantiate(question, 7).prompt));

		prompts.length = 0;
		await probeRound(env, state, "sk-test-12345678");
		expect(prompts).toEqual(Array(4).fill(instantiate(question, 8).prompt));
	});
});

describe("watchRotation", () => {
	it("rotates through every watch question on a watch made before questions could be picked", () => {
		expect(watchRotation(undefined).map((q) => q.id)).toEqual(["thibault", "candy", "candy-var", "ciallo"]);
	});

	it("rotates through the picked questions in bank order", () => {
		expect(watchRotation(["ciallo", "thibault"]).map((q) => q.id)).toEqual(["thibault", "ciallo"]);
	});
});

describe("alarmAfterUpdate", () => {
	it("pulls the queued round in for a shorter interval, keeps it for a longer one, and sleeps a paused watch", () => {
		const running = { status: { kind: "running" } as const, expiresAt: NOW + 86_400_000, intervalMin: 1 };
		expect(alarmAfterUpdate(running, NOW + 1_800_000, NOW)).toBe(NOW + 60_000);
		expect(alarmAfterUpdate({ ...running, intervalMin: 30 }, NOW + 60_000, NOW)).toBe(NOW + 60_000);
		expect(alarmAfterUpdate({ ...running, status: { kind: "paused" } }, NOW + 60_000, NOW)).toBe(NOW + 86_400_000);
	});
});

describe("planWatch", () => {
	it("purges once the idle date passes", () => {
		expect(planWatch({ status: { kind: "running" }, expiresAt: NOW, intervalMin: 5 }, NOW)).toEqual({ kind: "purge" });
	});

	it("sleeps a paused watch until its purge date", () => {
		expect(planWatch({ status: { kind: "paused" }, expiresAt: NOW + 1000, intervalMin: 5 }, NOW)).toEqual({
			kind: "sleep",
			until: NOW + 1000,
		});
	});

	it("probes a running watch and schedules the next round one interval out", () => {
		expect(planWatch({ status: { kind: "running" }, expiresAt: NOW + 3_600_000, intervalMin: 15 }, NOW)).toEqual({
			kind: "probe",
			nextAt: NOW + 900_000,
		});
	});

	it("never schedules past the purge date", () => {
		expect(planWatch({ status: { kind: "running" }, expiresAt: NOW + 60_000, intervalMin: 5 }, NOW)).toEqual({
			kind: "probe",
			nextAt: NOW + 60_000,
		});
	});
});

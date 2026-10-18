import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorResponse, MonitorSample } from "../../src/shared/monitor.ts";
import type { ProbeResult } from "../../src/worker/probe.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { default: worker } = await import("../../src/worker/index.ts");
const { monitorQuestions, pickQuestion, toSample } = await import("../../src/worker/monitor.ts");

const NOW = 1_800_000_000_000;
const KEY = "sk-gaoxin-test-12345678";
const sse = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;

function fakeMonitor(samples: MonitorSample[] = []) {
	const recorded: MonitorSample[] = [];
	const sinceArgs: number[] = [];
	const stub = {
		record: async (s: MonitorSample) => void recorded.push(s),
		since: async (ts: number) => (sinceArgs.push(ts), samples),
	};
	const names: string[] = [];
	const ctx = {
		waitUntil: () => {},
		exports: { Monitor: { idFromName: (name: string) => (names.push(name), name), get: () => stub } },
	};
	// Only the bindings these handlers touch are faked; the generated Env and ExecutionContext types are far wider.
	return { recorded, sinceArgs, names, ctx: ctx as unknown as ExecutionContext };
}

function env(key: string | undefined): Env {
	const values = { GAOXIN_KEY: key, MONITOR_SITE: "https://api.gaoxin.net.cn", MONITOR_MODEL: "gpt-6-astra" };
	return values as unknown as Env;
}

const controller = (scheduledTime: number) => ({ scheduledTime, cron: "* * * * *", noRetry: () => {} });

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("pickQuestion", () => {
	it("alternates the two scored questions by minute, sorted by id", () => {
		expect(monitorQuestions().map((q) => q.id)).toEqual(["candy", "thibault"]);
		const picks = [0, 59_999, 60_000, 120_000, 180_000].map((t) => pickQuestion(monitorQuestions(), t).id);
		expect(picks).toEqual(["candy", "candy", "thibault", "candy", "thibault"]);
	});

	it("wraps the minute index modulo the list length", () => {
		expect([0, 1, 2, 3, 7].map((m) => pickQuestion(["a", "b", "c"], m * 60_000))).toEqual(["a", "b", "c", "a", "b"]);
	});
});

describe("toSample", () => {
	const capture = { ttfbMs: 100, ttftMs: 250, totalMs: 400, answer: "Yes, I know him.", rawBody: "secret body" };
	const result = (overrides: object) => ({ capture: { ...capture, ...overrides } }) as unknown as ProbeResult;

	it("keeps only the numeric fields of a correct answer", () => {
		expect(toSample(NOW, "thibault", result({ ok: true, correct: true, reason: null, httpStatus: 200 }))).toEqual({
			ts: NOW, question: "thibault", ok: true, correct: true, reason: null, httpStatus: 200, totalMs: 400, ttfbMs: 100, ttftMs: 250,
		});
	});

	it("records a wrong answer as ok with correct false", () => {
		expect(toSample(NOW, "candy", result({ ok: true, correct: false, reason: null, httpStatus: 200 }))).toEqual({
			ts: NOW, question: "candy", ok: true, correct: false, reason: null, httpStatus: 200, totalMs: 400, ttfbMs: 100, ttftMs: 250,
		});
	});

	it("records a failure with its reason", () => {
		const failed = result({ ok: false, correct: null, reason: "unauthorized", httpStatus: 401, ttftMs: null, totalMs: 120 });
		expect(toSample(NOW, "candy", failed)).toEqual({
			ts: NOW, question: "candy", ok: false, correct: null, reason: "unauthorized", httpStatus: 401, totalMs: 120, ttfbMs: 100, ttftMs: null,
		});
	});
});

describe("scheduled", () => {
	it("skips without GAOXIN_KEY: no probe, no sample", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { recorded, ctx } = fakeMonitor();
		await worker.scheduled(controller(NOW), env(undefined), ctx);
		expect(fetch).not.toHaveBeenCalled();
		expect(recorded).toEqual([]);
		expect(log.mock.calls).toEqual([['{"event":"monitor_skipped","reason":"no_key"}']]);
	});

	it("treats the deploy-time placeholder as no key", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { recorded, ctx } = fakeMonitor();
		await worker.scheduled(controller(NOW), env("unset"), ctx);
		expect(fetch).not.toHaveBeenCalled();
		expect(recorded).toEqual([]);
		expect(log.mock.calls).toEqual([['{"event":"monitor_skipped","reason":"no_key"}']]);
	});

	it("probes the minute's question and stores one sample without the answer text", async () => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			requests.push(url);
			const body = [
				sse({ type: "response.output_text.delta", delta: "Yes, I know him." }),
				sse({ type: "response.completed", response: { id: "resp_68ab12cd34ef", usage: { input_tokens: 31 } } }),
			].join("");
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { recorded, names, ctx } = fakeMonitor();
		const minuteForThibault = 60_000 * 28_000_001;
		await worker.scheduled(controller(minuteForThibault), env(KEY), ctx);
		expect(requests).toEqual(["https://api.gaoxin.net.cn/v1/responses"]);
		expect(names).toEqual(["gaoxin"]);
		expect(recorded).toEqual([
			{ ts: minuteForThibault, question: "thibault", ok: true, correct: true, reason: null, httpStatus: 200, totalMs: 0, ttfbMs: 0, ttftMs: 0 },
		]);
		expect(JSON.stringify(recorded)).not.toContain("know him");
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({
			event: "monitor", host: "api.gaoxin.net.cn", question: "thibault", outcome: "correct", httpStatus: 200, totalMs: 0,
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
	});
});

describe("GET /api/monitor", () => {
	function fakeCache() {
		const puts: string[] = [];
		const matches: string[] = [];
		const cache = {
			match: async (req: Request) => (matches.push(req.url), undefined),
			put: async (req: Request) => void puts.push(req.url),
		};
		vi.stubGlobal("caches", { default: cache });
		return { puts, matches };
	}

	const get = (ctx: ExecutionContext, method = "GET") =>
		worker.fetch(new Request("https://gpt.ziikoo.app/api/monitor?bust=1", { method }), env(KEY), ctx);

	it("returns the buildMonitor shape, cacheable for 60s, without CORS headers", async () => {
		const { puts, matches } = fakeCache();
		const sample: MonitorSample = {
			ts: NOW - 60_000, question: "candy", ok: true, correct: true, reason: null, httpStatus: 200, totalMs: 900, ttfbMs: 300, ttftMs: 600,
		};
		const { sinceArgs, ctx } = fakeMonitor([sample]);
		const res = await get(ctx);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
		expect(res.headers.get("Content-Type")).toBe("application/json");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(sinceArgs).toEqual([NOW - 49 * 30 * 60_000]);
		expect(matches).toEqual(["https://gpt.ziikoo.app/api/monitor"]);
		expect(puts).toEqual(["https://gpt.ziikoo.app/api/monitor"]);
		const body = await res.json<MonitorResponse>();
		expect(body).toMatchObject({ target: "gaoxin.net.cn", intervalSec: 60, bucketMin: 30, generatedAt: NOW, configured: true, state: "operational", uptimePct: 100, correctPct: 100, last: sample });
		expect(body.buckets).toHaveLength(48);
	});

	it("reports configured false while GAOXIN_KEY is the deploy placeholder", async () => {
		fakeCache();
		const { ctx } = fakeMonitor();
		const res = await worker.fetch(new Request("https://gpt.ziikoo.app/api/monitor"), env("unset"), ctx);
		expect(await res.json<MonitorResponse>()).toMatchObject({ configured: false, state: "no_data" });
	});

	it("rejects POST with 405", async () => {
		fakeCache();
		const { ctx } = fakeMonitor();
		const res = await get(ctx, "POST");
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});
});

import { describe, expect, it } from "vitest";
import type { ProbeRequest, ProbeResponse } from "../../src/shared/types.ts";
import {
	applyOutcome,
	canAdd,
	deserializeCards,
	isDue,
	MAX_SITES,
	newCard,
	parseSite,
	pickQuestion,
	probeCard,
	probeDue,
	serializeCards,
	statusNotice,
	trimSamples,
	type CustomCard,
} from "../../src/web/custom-monitor.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const KEY = "sk-live-known-secret-0042";
const IDS = ["candy", "thibault"];
const card = (over: Partial<CustomCard> = {}): CustomCard => ({
	...newCard({ id: "ab12cd34", site: "https://relay.example", model: "gpt-6-astra", protocol: "responses", intervalMin: 2, createdAt: NOW }, "relay.example"),
	...over,
});
const correct: ProbeResponse = {
	ok: true, questionVersion: 1, correct: true, note: "ok", reasoningTokens: null, idShape: "other", answer: "21",
	streamed: true, ttfbMs: 100, ttftMs: 300, totalMs: 900, promptTokens: null, cachedTokens: null,
};
const unauthorized: ProbeResponse = { ok: false, reason: "unauthorized", httpStatus: 401 };
const reply = (response: ProbeResponse) => ({ kind: "response" as const, response });

describe("scheduling", () => {
	it("alternates the scored questions by minute, like the server monitor", () => {
		expect([0, 59_999, MIN, 2 * MIN].map((t) => pickQuestion(IDS, t))).toEqual(["candy", "candy", "thibault", "candy"]);
	});

	it("is due once the interval has passed since the last probe", async () => {
		const calls: ProbeRequest[] = [];
		const probe = async (body: ProbeRequest) => (calls.push(body), reply(correct));
		const first = (await probeCard(card(), KEY, IDS, probe, NOW + MIN))(card());
		expect(calls).toEqual([{ site: "https://relay.example", key: KEY, model: "gpt-6-astra", question: "thibault", protocol: "responses" }]);
		expect(first.samples).toEqual([
			{ ts: NOW + MIN, question: "thibault", ok: true, correct: true, reason: null, httpStatus: null, totalMs: 900, ttfbMs: 100, ttftMs: 300 },
		]);
		expect(isDue(first, NOW + 3 * MIN - 1)).toBe(false);
		expect(isDue(first, NOW + 3 * MIN)).toBe(true);
	});
});

describe("samples", () => {
	it("keeps the last 24 hours and at most 1440 samples", () => {
		const sample = (ts: number) => ({ ts, question: "candy", ok: true, correct: true, reason: null, httpStatus: null, totalMs: 1, ttfbMs: 1, ttftMs: 1 });
		expect(trimSamples([sample(NOW - 24 * 60 * MIN), sample(NOW - 1)], NOW).map((x) => x.ts)).toEqual([NOW - 1]);
		const many = Array.from({ length: 1500 }, (_, i) => sample(NOW - 1500 + i));
		const kept = trimSamples(many, NOW);
		expect(kept).toHaveLength(1440);
		expect(kept[0]!.ts).toBe(NOW - 1440);
	});
});

describe("status", () => {
	it("pauses on this site's 429 and resumes when the wait is over", () => {
		const limited = applyOutcome(card(), "candy", { kind: "stop", status: 429, message: "请求过于频繁", retryAfterSec: 30 }, NOW);
		expect(limited.status).toEqual({ kind: "rate_limited", until: NOW + 30_000 });
		expect(limited.samples).toEqual([]);
		expect(statusNotice(limited.status, NOW + 12_500)).toBe("本站限流，18 秒后继续");
		expect(isDue(limited, NOW + 29_999)).toBe(false);
		expect(isDue(limited, NOW + 30_000)).toBe(true);
		expect(applyOutcome(limited, "candy", reply(correct), NOW + 30_000).status).toEqual({ kind: "running" });
	});

	it("asks for a new key after five unauthorized replies in a row", () => {
		let c = card();
		for (let i = 0; i < 4; i++) c = applyOutcome(c, "candy", reply(unauthorized), NOW + i);
		expect(c.status).toEqual({ kind: "running" });
		expect(applyOutcome(applyOutcome(c, "candy", reply(correct), NOW), "candy", reply(unauthorized), NOW).unauthorized).toBe(1);
		c = applyOutcome(c, "candy", reply(unauthorized), NOW + 4);
		expect(c.status).toEqual({ kind: "bad_key" });
		expect(c.samples.filter((s) => s.reason === "unauthorized")).toHaveLength(5);
		expect(statusNotice(c.status, NOW)).toBe("密钥无效，请重新输入");
	});

	it("keeps a pause made while a call was in flight", () => {
		expect(applyOutcome(card({ status: { kind: "paused" } }), "candy", reply(correct), NOW).status).toEqual({ kind: "paused" });
	});

	it("stops on a Worker 400 with its message", () => {
		const c = applyOutcome(card(), "candy", { kind: "stop", status: 400, message: "目标地址不允许", retryAfterSec: null }, NOW);
		expect(c.status).toEqual({ kind: "rejected", message: "目标地址不允许" });
	});
});

describe("key hygiene", () => {
	it("forgets the key once a card turns bad_key and never probes with it again", async () => {
		const keys = new Map([["ab12cd34", KEY]]);
		const sent: string[] = [];
		const probe = async (body: ProbeRequest) => (sent.push(body.key), reply(unauthorized));
		const update = await probeDue(card({ unauthorized: 4 }), keys, IDS, probe, NOW);
		const bad = update!(card({ unauthorized: 4 }));
		expect(bad.status).toEqual({ kind: "bad_key" });
		expect(keys.has("ab12cd34")).toBe(false);
		expect(await probeDue(card({ unauthorized: 4 }), keys, IDS, probe, NOW + 10 * MIN)).toBeNull();
		expect(sent).toEqual([KEY]);
	});

	it("keeps the key while the card keeps running", async () => {
		const keys = new Map([["ab12cd34", KEY]]);
		await probeDue(card(), keys, IDS, async () => reply(unauthorized), NOW);
		expect(keys.get("ab12cd34")).toBe(KEY);
	});
});

describe("protocol", () => {
	it("probes on the card's channel and stores it", async () => {
		const calls: ProbeRequest[] = [];
		const chat = card({ protocol: "chat" });
		await probeCard(chat, KEY, IDS, async (b) => (calls.push(b), reply(correct)), NOW);
		expect(calls.map((c) => c.protocol)).toEqual(["chat"]);
		expect(deserializeCards(serializeCards([chat]), NOW)[0]!.protocol).toBe("chat");
	});

	it("defaults a missing channel to responses and drops an unknown one", () => {
		const site = { id: "x", site: "https://a.example", model: "m", intervalMin: 1, createdAt: 1, samples: [] };
		expect(deserializeCards(JSON.stringify({ sites: [site] }), NOW)[0]!.protocol).toBe("responses");
		expect(deserializeCards(JSON.stringify({ sites: [{ ...site, protocol: "grpc" }] }), NOW)).toEqual([]);
	});
});

describe("persistence", () => {
	it("never writes the key, and restored cards wait for it", async () => {
		const probe = async () => reply(correct);
		const live = (await probeCard(card(), KEY, IDS, probe, NOW))(card());
		const stored = serializeCards([live]);
		expect(stored).not.toContain(KEY);
		const [restored] = deserializeCards(stored, NOW + MIN);
		expect(restored).toMatchObject({ id: "ab12cd34", host: "relay.example", intervalMin: 2, status: { kind: "needs_key" } });
		expect(restored!.samples).toHaveLength(1);
		expect(statusNotice(restored!.status, NOW)).toBe("已暂停：需要重新输入密钥才能继续");
	});

	it("drops corrupt storage and entries that are not https", () => {
		expect(deserializeCards("{not json", NOW)).toEqual([]);
		const raw = JSON.stringify({ sites: [{ id: "x", site: "http://a.example", model: "m", intervalMin: 1, createdAt: 1, samples: [] }] });
		expect(deserializeCards(raw, NOW)).toEqual([]);
	});

	it("caps custom sites at six", () => {
		const six = Array.from({ length: MAX_SITES }, (_, i) => card({ id: `id${i}` }));
		expect(canAdd(six.slice(0, 5))).toBe(true);
		expect(canAdd(six)).toBe(false);
		expect(deserializeCards(serializeCards([...six, card({ id: "seventh" })]), NOW)).toHaveLength(6);
	});
});

describe("parseSite", () => {
	it("accepts https only", () => {
		expect(parseSite(" https://relay.example/v1 ")).toEqual({ ok: true, site: "https://relay.example/v1", host: "relay.example" });
		expect(parseSite("http://relay.example")).toEqual({ ok: false, message: "只支持 https 地址" });
		expect(parseSite("relay.example")).toEqual({ ok: false, message: "请输入完整地址，例如 https://example.com" });
	});
});

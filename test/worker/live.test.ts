import { describe, expect, it, vi } from "vitest";
import { buildMonitor } from "../../src/shared/monitor.ts";
import type { WatchView } from "../../src/shared/watch.ts";
import { LIVE_TOPIC_RE, liveTopic, publishWatchEvent, watchLive } from "../../src/worker/live.ts";

const sampleView = (host = "relay.example", liveTopicValue?: string): WatchView => ({
	site: `https://${host}`,
	host,
	alias: "",
	model: "gpt-6-astra",
	protocol: "responses",
	intervalMin: 5,
	questions: ["thibault"],
	createdAt: 1_000,
	status: { kind: "running" },
	expiresAt: 2_000,
	monitor: buildMonitor([], 1_000, host, 300),
	usage: null,
	perf: null,
	...(liveTopicValue ? { liveTopic: liveTopicValue } : {}),
});

describe("liveTopic and LIVE_TOPIC_RE", () => {
	it("produces a valid watch:<64-hex> topic and separates domains", async () => {
		const topic = await liveTopic("pepper-secret", "watch-id-1");
		expect(topic).toMatch(LIVE_TOPIC_RE);
		expect(await liveTopic("pepper-secret", "watch-id-1")).toBe(topic);
		expect(await liveTopic("pepper-secret", "watch-id-2")).not.toBe(topic);
		expect(await liveTopic("other-pepper", "watch-id-1")).not.toBe(topic);
	});

	it("accepts only lowercase 64-hex watch topics", () => {
		expect(LIVE_TOPIC_RE.test(`watch:${"0123456789abcdef".repeat(4)}`)).toBe(true);
		expect(LIVE_TOPIC_RE.test(`watch:${"0123456789ABCDEF".repeat(4)}`)).toBe(false);
		expect(LIVE_TOPIC_RE.test(`watch:${"a".repeat(63)}`)).toBe(false);
		expect(LIVE_TOPIC_RE.test(`watch:${"a".repeat(65)}`)).toBe(false);
		expect(LIVE_TOPIC_RE.test(`board:${"a".repeat(64)}`)).toBe(false);
		expect(LIVE_TOPIC_RE.test("")).toBe(false);
	});
});

describe("watchLive onSubscribe", () => {
	const controlCtx = (topic: string, env: unknown) =>
		({
			req: {
				raw: new Request("https://gpt.ziikoo.app/api/board/live", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						connectionId: "1234567890123456",
						operations: [{ kind: "subscribe", id: "sub1", topic }],
					}),
				}),
			},
			env,
			get: () => null,
		}) as unknown as Parameters<typeof watchLive.control>[0];

	it.each(["bad-topic", `watch:${"A".repeat(64)}`, `watch:${"a".repeat(63)}`])(
		"rejects invalid topic %s with 400 before touching VOID_LIVE",
		async (topic) => {
			let touched = false;
			const env = {
				VOID_LIVE: {
					idFromName: () => {
						touched = true;
						throw new Error("VOID_LIVE must not be touched");
					},
				},
			};
			const res = await watchLive.control(controlCtx(topic, env));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				accepted: true,
				connectionId: "1234567890123456",
				results: [
					{
						ok: false,
						kind: "subscribe",
						id: "sub1",
						error: { code: "BAD_REQUEST", message: "invalid topic" },
					},
				],
			});
			expect(touched).toBe(false);
		},
	);

	it("allows valid watch topics through to VOID_LIVE", async () => {
		const validTopic = await liveTopic("pepper-secret", "watch-1");
		const env = {
			VOID_LIVE: {
				idFromName: (name: string) => name,
				get: () => ({
					fetch: async () =>
						Response.json({
							accepted: true,
							connectionId: "1234567890123456",
							results: [{ ok: true, kind: "subscribe", id: "sub1", topic: validTopic }],
						}),
				}),
			},
		};
		const res = await watchLive.control(controlCtx(validTopic, env));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			accepted: true,
			connectionId: "1234567890123456",
			results: [{ ok: true, kind: "subscribe", id: "sub1", topic: validTopic }],
		});
	});
});

describe("publishWatchEvent", () => {
	it("is a no-op when VOID_LIVE or PEPPER is missing", async () => {
		const fetchSpy = vi.fn();
		const stub = { idFromName: (name: string) => name, get: () => ({ fetch: fetchSpy }) } as unknown as DurableObjectNamespace;
		await expect(publishWatchEvent({ PEPPER: "pepper" }, "id-1", { kind: "deleted" })).resolves.toBeUndefined();
		await expect(publishWatchEvent({ VOID_LIVE: stub }, "id-1", { kind: "deleted" })).resolves.toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("publishes update/deleted events to VOID_LIVE under the derived topic", async () => {
		const delivered: unknown[] = [];
		const stub = {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
					delivered.push(JSON.parse(String(init?.body)));
					return new Response(null, { status: 204 });
				},
			}),
		} as unknown as DurableObjectNamespace;
		const expectedTopic = await liveTopic("pepper-secret", "watch-1");
		const view = sampleView("relay.example", expectedTopic);

		await publishWatchEvent({ PEPPER: "pepper-secret", VOID_LIVE: stub }, "watch-1", { kind: "update", view });
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({ topic: expectedTopic, data: { kind: "update", view } });
	});

	it("swallows errors from VOID_LIVE as best-effort push", async () => {
		const throwing = {
			idFromName: () => {
				throw new Error("do unreachable");
			},
		} as unknown as DurableObjectNamespace;
		const failing = {
			idFromName: (name: string) => name,
			get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }),
		} as unknown as DurableObjectNamespace;

		await expect(publishWatchEvent({ PEPPER: "pepper-secret", VOID_LIVE: throwing }, "id-1", { kind: "deleted" })).resolves.toBeUndefined();
		await expect(publishWatchEvent({ PEPPER: "pepper-secret", VOID_LIVE: failing }, "id-1", { kind: "deleted" })).resolves.toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { buildMonitor } from "../../src/shared/monitor.ts";
import type { WatchView } from "../../src/shared/watch.ts";
import { applyWatchLiveEvent, type WatchCard } from "../../src/web/watch-live.ts";

const makeView = (host: string, opts: { liveTopic?: string; intervalMin?: number } = {}): WatchView => ({
	site: `https://${host}`,
	host,
	alias: "",
	model: "gpt-6-astra",
	protocol: "responses",
	intervalMin: opts.intervalMin ?? 5,
	questions: ["thibault"],
	createdAt: 1_000,
	status: { kind: "running" },
	expiresAt: 2_000,
	monitor: buildMonitor([], 1_000, host, (opts.intervalMin ?? 5) * 60),
	usage: null,
	perf: null,
	...(opts.liveTopic ? { liveTopic: opts.liveTopic } : {}),
});

describe("applyWatchLiveEvent", () => {
	const topicA = `watch:${"a".repeat(64)}`;
	const topicB = `watch:${"b".repeat(64)}`;
	const cards: WatchCard[] = [
		{ kind: "loading", token: "loading-token" },
		{ kind: "live", token: "token-a", view: makeView("a.example", { liveTopic: topicA, intervalMin: 5 }), actionError: null },
		{ kind: "live", token: "token-b", view: makeView("b.example", { liveTopic: topicB, intervalMin: 10 }), actionError: "keep" },
		{ kind: "error", token: "error-token", message: "读取失败" },
	];

	it("updates the matching live card's view on an update event", () => {
		const updatedView = makeView("a.example", { liveTopic: topicA, intervalMin: 1 });
		const next = applyWatchLiveEvent(cards, topicA, { kind: "update", view: updatedView });
		expect(next).toHaveLength(4);
		expect(next[0]).toBe(cards[0]);
		expect(next[1]).toEqual({ kind: "live", token: "token-a", view: updatedView, actionError: null });
		expect(next[2]).toBe(cards[2]);
		expect(next[3]).toBe(cards[3]);
	});

	it("removes the matching live card on a deleted event", () => {
		const next = applyWatchLiveEvent(cards, topicA, { kind: "deleted" });
		expect(next).toEqual([cards[0], cards[2], cards[3]]);
	});

	it("returns the original array when the topic does not match any live card", () => {
		const unknown = `watch:${"c".repeat(64)}`;
		expect(applyWatchLiveEvent(cards, unknown, { kind: "deleted" })).toBe(cards);
		expect(applyWatchLiveEvent(cards, unknown, { kind: "update", view: makeView("c.example", { liveTopic: unknown }) })).toBe(cards);
	});
});

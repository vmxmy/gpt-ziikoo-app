import { describe, expect, it } from "vitest";
import { buildMonitor, type MonitorSample } from "../../src/shared/monitor.ts";
import { agoText, badgeLabel, latencyP50, metaLine, monitorView, stamp, tableRows, tokenAmount, usageNote } from "../../src/web/monitor-view.ts";

const NOW = 1_800_000_000_000;
const sample = (minutesAgo: number, totalMs: number): MonitorSample => ({
	ts: NOW - minutesAgo * 60_000,
	question: "candy",
	ok: true,
	correct: true,
	reason: null,
	httpStatus: 200,
	totalMs,
	ttfbMs: 100,
	ttftMs: 200,
});

describe("monitorView", () => {
	it("tells an empty window apart from one with samples", () => {
		expect(monitorView(buildMonitor([], NOW, "relay.example", 60)).kind).toBe("waiting");
		expect(monitorView(buildMonitor([sample(1, 900)], NOW, "relay.example", 60)).kind).toBe("live");
	});

	it("labels the badge from the last hour", () => {
		expect(badgeLabel(monitorView(buildMonitor([], NOW, "t", 60)))).toBe("暂无数据");
		expect(badgeLabel(monitorView(buildMonitor([sample(1, 900)], NOW, "t", 60)))).toBe("调用数不足");
		const enough = Array.from({ length: 10 }, (_, i) => sample(i + 1, 900));
		expect(badgeLabel(monitorView(buildMonitor(enough, NOW, "t", 60)))).toBe("运行正常");
	});
});

describe("tableRows", () => {
	it("keeps only buckets with calls and puts the newest first", () => {
		const { buckets } = buildMonitor([sample(1, 900), sample(2, 800), sample(100, 700)], NOW, "t", 60);
		const rows = tableRows(buckets);
		expect(rows.map((b) => b.total)).toEqual([2, 1]);
		expect(rows[0]!.start).toBeGreaterThan(rows[1]!.start);
		expect(buckets.filter((b) => b.total === 0).length).toBe(46);
	});
});

describe("monitor text", () => {
	it("says how long ago the last probe ran", () => {
		expect(agoText(NOW - 30_000, NOW)).toBe("不到 1 分钟前");
		expect(agoText(NOW - 3 * 60_000, NOW)).toBe("3 分钟前");
		expect(agoText(NOW - 125 * 60_000, NOW)).toBe("2 小时前");
	});

	it("omits the last probe when there is none", () => {
		expect(metaLine(buildMonitor([], NOW, "relay.example", 60), NOW)).toBe("站点 relay.example · 每 1 分钟一次");
		expect(metaLine(buildMonitor([sample(2, 900)], NOW, "relay.example", 60), NOW)).toBe(
			"站点 relay.example · 每 1 分钟一次 · 最近一次调用 2 分钟前",
		);
	});

	it("states longer custom intervals in minutes", () => {
		const custom = buildMonitor([], NOW, "relay.example", 300);
		expect(metaLine(custom, NOW)).toBe("站点 relay.example · 每 5 分钟一次");
	});

	it("names the channel of a custom card", () => {
		expect(metaLine(buildMonitor([], NOW, "relay.example", 60), NOW, "chat")).toBe("站点 relay.example · 每 1 分钟一次 · 协议 chat");
		expect(metaLine(buildMonitor([], NOW, "relay.example", 60), NOW, "chat", ["thibault", "ciallo"])).toBe(
			"站点 relay.example · 每 1 分钟一次 · 协议 chat · 题目 thibault、ciallo",
		);
	});

	it("takes the median of the bucket medians", () => {
		expect(latencyP50(buildMonitor([], NOW, "t", 60).buckets)).toBeNull();
		const odd = buildMonitor([sample(1, 900), sample(31, 300), sample(61, 1200)], NOW, "t", 60);
		expect(latencyP50(odd.buckets)).toBe(900);
		const even = buildMonitor([sample(1, 900), sample(31, 300)], NOW, "t", 60);
		expect(latencyP50(even.buckets)).toBe(600);
	});
});

describe("tokenAmount", () => {
	it("groups small counts and shortens large ones to 万 and 亿", () => {
		expect(tokenAmount(8420)).toBe("8,420");
		expect(tokenAmount(123456)).toBe("12.3 万");
		expect(tokenAmount(123456789)).toBe("1.23 亿");
	});
});

describe("usageNote", () => {
	const usage = { since: NOW, calls: 12, unmetered: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };

	it("states the start and the number of calls", () => {
		expect(usageNote(usage)).toBe(`自 ${stamp(NOW)} 起，调用 12 次。`);
	});

	it("adds how many calls gave no usage", () => {
		expect(usageNote({ ...usage, unmetered: 2 })).toBe(`自 ${stamp(NOW)} 起，调用 12 次，其中 2 次没有返回用量。`);
	});
});

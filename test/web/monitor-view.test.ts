import { describe, expect, it } from "vitest";
import { buildMonitor, type MonitorSample } from "../../src/shared/monitor.ts";
import { agoText, badgeLabel, latencyP50, metaLine, monitorView } from "../../src/web/monitor-view.ts";

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
	it("tells a missing key apart from a failed request and from an empty window", () => {
		expect(monitorView(undefined)).toEqual({ kind: "loading" });
		expect(monitorView(null)).toEqual({ kind: "unavailable" });
		expect(monitorView(buildMonitor([], NOW, "gaoxin.net.cn", false)).kind).toBe("disabled");
		expect(monitorView(buildMonitor([], NOW, "gaoxin.net.cn", true)).kind).toBe("waiting");
		expect(monitorView(buildMonitor([sample(1, 900)], NOW, "gaoxin.net.cn", true)).kind).toBe("live");
	});

	it("labels the badge 未启用 only when the key is missing", () => {
		expect(badgeLabel(monitorView(buildMonitor([], NOW, "t", false)))).toBe("未启用");
		expect(badgeLabel(monitorView(buildMonitor([], NOW, "t", true)))).toBe("暂无数据");
		expect(badgeLabel(monitorView(null))).toBe("暂无数据");
		expect(badgeLabel(monitorView(buildMonitor([sample(1, 900)], NOW, "t", true)))).toBe("运行正常");
	});
});

describe("monitor text", () => {
	it("says how long ago the last probe ran", () => {
		expect(agoText(NOW - 30_000, NOW)).toBe("不到 1 分钟前");
		expect(agoText(NOW - 3 * 60_000, NOW)).toBe("3 分钟前");
		expect(agoText(NOW - 125 * 60_000, NOW)).toBe("2 小时前");
	});

	it("omits the last probe when there is none", () => {
		expect(metaLine(buildMonitor([], NOW, "gaoxin.net.cn", true), NOW)).toBe("目标 gaoxin.net.cn · 每 60 秒一次");
		expect(metaLine(buildMonitor([sample(2, 900)], NOW, "gaoxin.net.cn", true), NOW)).toBe(
			"目标 gaoxin.net.cn · 每 60 秒一次 · 最近一次探测 2 分钟前",
		);
	});

	it("states longer custom intervals in minutes", () => {
		const custom = { ...buildMonitor([], NOW, "relay.example", true), intervalSec: 300 };
		expect(metaLine(custom, NOW)).toBe("目标 relay.example · 每 5 分钟一次");
	});

	it("takes the median of the bucket medians", () => {
		expect(latencyP50(buildMonitor([], NOW, "t", true).buckets)).toBeNull();
		const odd = buildMonitor([sample(1, 900), sample(31, 300), sample(61, 1200)], NOW, "t", true);
		expect(latencyP50(odd.buckets)).toBe(900);
		const even = buildMonitor([sample(1, 900), sample(31, 300)], NOW, "t", true);
		expect(latencyP50(even.buckets)).toBe(600);
	});
});

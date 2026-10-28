import { MONITOR, type MonitorBucket, type MonitorResponse, type MonitorState } from "../shared/monitor.ts";
import type { Protocol } from "../shared/types.ts";

export type MonitorView = { kind: "waiting" | "live"; data: MonitorResponse };

export const STATE_LABEL: Record<MonitorState, string> = {
	operational: "运行正常",
	fair: "基本正常",
	quality: "降智",
	degraded: "不稳定",
	down: "故障",
	insufficient: "调用数不足",
	no_data: "暂无数据",
};

export const WAITING_NOTICE = "等待第一次调用的结果。按设定间隔调用站点，结果出来后这里会更新。";
export const SPARSE_NOTICE = "再过一个半小时格，耗时折线会出现。";

export function monitorView(data: MonitorResponse): MonitorView {
	return { kind: data.last === null ? "waiting" : "live", data };
}

export const badgeLabel = (view: MonitorView): string => STATE_LABEL[view.data.state];

export function agoText(ts: number, now: number): string {
	const minutes = Math.max(0, Math.floor((now - ts) / 60_000));
	if (minutes === 0) return "不到 1 分钟前";
	return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}

export function metaLine(data: MonitorResponse, now: number, protocol?: Protocol, questions?: readonly string[]): string {
	const parts = [`站点 ${data.target}`, `每 ${data.intervalSec / 60} 分钟一次`];
	if (protocol) parts.push(`协议 ${protocol}`);
	if (questions?.length) parts.push(`题目 ${questions.join("、")}`);
	if (data.last) parts.push(`最近一次调用 ${agoText(data.last.ts, now)}`);
	return parts.join(" · ");
}

// The response carries per-bucket medians only, so the 24-hour figure is the median of those medians.
export function latencyP50(buckets: MonitorBucket[]): number | null {
	const values = buckets.flatMap((b) => (b.totalMs ? [b.totalMs.p50] : [])).sort((a, b) => a - b);
	if (values.length === 0) return null;
	const mid = Math.floor(values.length / 2);
	return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

export const clock = (ts: number) =>
	new Date(ts).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });

export const stamp = (ts: number) =>
	new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

// Buckets without a call carry no numbers; the newest come first so the table opens on data.
export const tableRows = (buckets: MonitorBucket[]): MonitorBucket[] => buckets.filter((b) => b.total > 0).reverse();

export function segmentLabel(b: MonitorBucket): string {
	if (b.start === 0) return STATE_LABEL.no_data;
	const end = b.start + MONITOR.bucketMin * 60_000;
	return `${clock(b.start)}–${clock(end)} · ${STATE_LABEL[b.state]} · 调用 ${b.total} · 失败 ${b.failed} · 答错 ${b.wrong} · 统计范围 ${b.windowTotal} 次调用`;
}

export const emptyBuckets = (): MonitorBucket[] =>
	Array.from({ length: MONITOR.buckets }, () => ({
		start: 0,
		state: "no_data",
		windowTotal: 0,
		total: 0,
		failed: 0,
		wrong: 0,
		totalMs: null,
		ttftMs: null,
	}));

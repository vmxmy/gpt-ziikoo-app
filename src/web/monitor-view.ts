import { MONITOR, type MonitorBucket, type MonitorResponse, type MonitorState } from "../shared/monitor.ts";

export type MonitorView =
	| { kind: "loading" }
	| { kind: "unavailable" }
	| { kind: "disabled"; data: MonitorResponse }
	| { kind: "waiting"; data: MonitorResponse }
	| { kind: "live"; data: MonitorResponse };

export type EmptyKind = Exclude<MonitorView["kind"], "live">;

export const STATE_LABEL: Record<MonitorState, string> = {
	operational: "运行正常",
	degraded: "降级",
	down: "故障",
	no_data: "暂无数据",
};

export const EMPTY_NOTICE: Record<EmptyKind, string> = {
	loading: "正在读取监测数据…",
	unavailable: "监测暂不可用，稍后刷新页面再看。",
	disabled: "监测尚未启用：运营方还没有配置监测密钥。配置后这里会每分钟更新。",
	waiting: "等待第一个样本。按设定间隔探测，第一次结果出来后这里会更新。",
};

// undefined means the first request has not settled; null means it failed.
export function monitorView(data: MonitorResponse | null | undefined): MonitorView {
	if (data === undefined) return { kind: "loading" };
	if (data === null) return { kind: "unavailable" };
	if (!data.configured) return { kind: "disabled", data };
	if (data.last === null) return { kind: "waiting", data };
	return { kind: "live", data };
}

export function badgeLabel(view: MonitorView): string {
	if (view.kind === "disabled") return "未启用";
	return STATE_LABEL["data" in view ? view.data.state : "no_data"];
}

export function agoText(ts: number, now: number): string {
	const minutes = Math.max(0, Math.floor((now - ts) / 60_000));
	if (minutes === 0) return "不到 1 分钟前";
	return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}

export function metaLine(data: MonitorResponse, now: number): string {
	const every = data.intervalSec >= 120 ? `${data.intervalSec / 60} 分钟` : `${data.intervalSec} 秒`;
	const parts = [`目标 ${data.target}`, `每 ${every}一次`];
	if (data.last) parts.push(`最近一次探测 ${agoText(data.last.ts, now)}`);
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

export function segmentLabel(b: MonitorBucket): string {
	if (b.start === 0) return STATE_LABEL.no_data;
	const end = b.start + MONITOR.bucketMin * 60_000;
	return `${clock(b.start)}–${clock(end)} · ${STATE_LABEL[b.state]} · 调用 ${b.total} · 失败 ${b.failed} · 答错 ${b.wrong}`;
}

export const emptyBuckets = (): MonitorBucket[] =>
	Array.from({ length: MONITOR.buckets }, () => ({
		start: 0,
		state: "no_data",
		total: 0,
		failed: 0,
		wrong: 0,
		totalMs: null,
		ttftMs: null,
	}));

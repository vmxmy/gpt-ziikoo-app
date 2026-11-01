import type { MonitorResponse } from "./monitor.ts";
import type { Protocol } from "./types.ts";

export const WATCH_INTERVALS = [1, 5, 10, 30] as const;
export type WatchIntervalMin = (typeof WATCH_INTERVALS)[number];
export const WATCH_MAX_TOTAL = 200;
export const WATCH_IDLE_DAYS = 7;
export const WATCH_MAX_ALIAS = 40;
export const BOARD_MAX_WATCHES = 30;

export const isWatchInterval = (v: unknown): v is WatchIntervalMin => WATCH_INTERVALS.some((i) => i === v);

export type WatchStrategy = {
	id: "authenticity" | "saver" | "line";
	label: string;
	answers: string;
	note?: string;
	intervalMin: WatchIntervalMin;
	questions: readonly string[];
};
// Form presets, never stored: a watch keeps the interval and questions they filled in, so a later change here cannot raise what an existing watch spends.
export const WATCH_STRATEGIES: readonly WatchStrategy[] = [
	{ id: "authenticity", label: "真伪核查", answers: "模型是不是一直是原装？", intervalMin: 5, questions: ["thibault", "candy", "candy-var", "ciallo"] },
	{ id: "saver", label: "省额度值守", answers: "密钥还正常吗，模型有没有变笨？", intervalMin: 30, questions: ["thibault", "candy-var"] },
	{ id: "line", label: "线路值守", answers: "站点断了没有？", note: "不推送告警，要打开看板查看。", intervalMin: 1, questions: ["thibault"] },
];

export const matchStrategy = ({ intervalMin, questions }: { intervalMin: number; questions: readonly string[] }): WatchStrategy | undefined =>
	WATCH_STRATEGIES.find((s) => s.intervalMin === intervalMin && s.questions.length === questions.length && s.questions.every((q) => questions.includes(q)));

export const dailyCalls = (intervalMin: number): number => (24 * 60) / intervalMin;

export type WatchStatus = { kind: "running" } | { kind: "paused" } | { kind: "bad_key" };

export type WatchCreateRequest = {
	site: string;
	key: string;
	model: string;
	protocol: Protocol;
	intervalMin: WatchIntervalMin;
	questions: string[];
	alias: string;
	consent: true;
	board?: string;
};
export type WatchTokenRequest = { token: string };
export type WatchStateRequest = { token: string; action: "pause" | "resume" };
export type WatchChange = { questions?: string[]; intervalMin?: WatchIntervalMin };
export type WatchUpdateRequest = { token: string } & WatchChange;
export type BoardViewRequest = { board: string };
export type BoardAdoptRequest = { board?: string; tokens: string[] };
export type BoardMoveRequest = { from: string; into?: string };
export type BoardOrderRequest = { board: string; tokens: string[] };

export type WatchUsage = {
	since: number;
	calls: number;
	unmetered: number;
	promptTokens: number;
	cachedTokens: number;
	outputTokens: number;
	reasoningTokens: number;
};

export type WatchView = {
	site: string;
	host: string;
	alias: string;
	model: string;
	protocol: Protocol;
	// A watch made before the interval list changed may still run every 15 minutes.
	intervalMin: number;
	questions: string[];
	createdAt: number;
	status: WatchStatus;
	expiresAt: number;
	monitor: MonitorResponse;
	// Null on a watch made before usage was counted that has not finished a round since.
	usage: WatchUsage | null;
};
export type WatchCreateResponse = { board: string; token: string; watch: WatchView };
export type WatchDeleteResponse = { deleted: true };
export type WatchCreateError =
	| { error: "bad_request"; message: string; field: "site" | "key" | "model" }
	| { error: "watch_limit"; message: string };
export type BoardViewResponse = { watches: { token: string; watch: WatchView | null }[] };
export type BoardAdoptResponse = { board: string | null };
export type BoardMoveResponse = { board: string };
export type BoardOrderResponse = { tokens: string[] };

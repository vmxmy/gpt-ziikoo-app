import type { MonitorResponse } from "./monitor.ts";
import type { Protocol } from "./types.ts";

export const WATCH_INTERVALS = [5, 15] as const;
export type WatchIntervalMin = (typeof WATCH_INTERVALS)[number];
export const WATCH_MAX_PER_IP = 6;
export const WATCH_MAX_TOTAL = 200;
export const WATCH_IDLE_DAYS = 7;
export const WATCH_MAX_ALIAS = 40;
export const BOARD_MAX_WATCHES = 30;

export const isWatchInterval = (v: unknown): v is WatchIntervalMin => WATCH_INTERVALS.some((i) => i === v);

export type WatchStatus = { kind: "running" } | { kind: "paused" } | { kind: "bad_key" };

export type WatchCreateRequest = {
	site: string;
	key: string;
	model: string;
	protocol: Protocol;
	intervalMin: WatchIntervalMin;
	alias: string;
	consent: true;
	board?: string;
};
export type WatchTokenRequest = { token: string };
export type WatchStateRequest = { token: string; action: "pause" | "resume" };
export type BoardViewRequest = { board: string };
export type BoardAdoptRequest = { board?: string; tokens: string[] };
export type BoardMoveRequest = { from: string; into?: string };
export type BoardOrderRequest = { board: string; tokens: string[] };

export type WatchView = {
	site: string;
	host: string;
	alias: string;
	model: string;
	protocol: Protocol;
	intervalMin: WatchIntervalMin;
	createdAt: number;
	status: WatchStatus;
	expiresAt: number;
	monitor: MonitorResponse;
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

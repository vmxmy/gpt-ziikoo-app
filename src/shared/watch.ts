import type { MonitorResponse } from "./monitor.ts";
import type { Protocol } from "./types.ts";

export const WATCH_INTERVALS = [5, 15] as const;
export type WatchIntervalMin = (typeof WATCH_INTERVALS)[number];
export const WATCH_MAX_PER_IP = 6;
export const WATCH_MAX_TOTAL = 200;
export const WATCH_IDLE_DAYS = 7;
export const WATCH_MAX_ALIAS = 40;

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
};
export type WatchTokenRequest = { token: string };
export type WatchStateRequest = { token: string; action: "pause" | "resume" };

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
export type WatchCreateResponse = { token: string; watch: WatchView };
export type WatchDeleteResponse = { deleted: true };
export type WatchCreateError =
	| { error: "bad_request"; message: string; field: "site" | "key" | "model" }
	| { error: "watch_limit"; message: string };

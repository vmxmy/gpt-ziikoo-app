import type { MonitorResponse } from "../shared/monitor.ts";
import type { ApiError, HistoryRawResponse, HistoryResponse, ProbeResponse, QuestionListItem } from "../shared/types.ts";
import type { Probe } from "./runner.ts";

export type Target = { site: string; key: string };

export class ApiFailure extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly retryAfterSec: number | null,
	) {
		super(message);
	}
}

async function post(path: string, body: object, signal?: AbortSignal): Promise<Response> {
	return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

async function failure(res: Response): Promise<ApiFailure> {
	const body: Partial<ApiError> = await res.json().catch(() => ({}));
	const retry = body.retryAfterSec ?? Number(res.headers.get("Retry-After"));
	const message =
		res.status === 429 ? (body.error === "too_many_calls" ? (body.message ?? "本轮调用次数已到上限") : "请求过于频繁") : (body.message ?? `接口返回 ${res.status}`);
	return new ApiFailure(res.status, message, Number.isFinite(retry) && retry > 0 ? retry : null);
}

async function postJson<T>(path: string, body: object): Promise<T> {
	const res = await post(path, body);
	if (!res.ok) throw await failure(res);
	return res.json();
}

export async function fetchQuestions(): Promise<QuestionListItem[]> {
	const res = await fetch("/api/questions");
	if (!res.ok) throw await failure(res);
	return res.json();
}

export function makeProbe(target: Target, model: string): Probe {
	return async (args, signal) => {
		let body: ProbeResponse;
		try {
			const res = await post("/api/probe", { ...target, model, ...args }, signal);
			if (!res.ok) {
				const f = await failure(res);
				return { kind: "stop", status: f.status, message: f.message, retryAfterSec: f.retryAfterSec };
			}
			body = await res.json();
		} catch (err) {
			if (signal.aborted) throw err;
			return { kind: "network_error" };
		}
		return { kind: "response", response: body };
	};
}

export const fetchHistory = (t: Target) => postJson<HistoryResponse>("/api/history", t);
export const fetchHistoryRaw = (t: Target, runId: string) => postJson<HistoryRawResponse>("/api/history/raw", { ...t, runId });
export const deleteHistory = (t: Target) => postJson<{ deleted: boolean }>("/api/history/delete", t);

// The endpoint may not be deployed yet, so any failure reads as "no data" rather than an error.
export async function fetchMonitor(): Promise<MonitorResponse | null> {
	const res = await fetch("/api/monitor").catch(() => null);
	if (!res?.ok) return null;
	const body: MonitorResponse | null = await res.json().catch(() => null);
	return body && typeof body.state === "string" && Array.isArray(body.buckets) ? body : null;
}

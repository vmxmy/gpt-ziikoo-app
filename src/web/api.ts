import type { ApiError, HistoryRawResponse, HistoryResponse, ProbeRequest, ProbeResponse, QuestionListItem } from "../shared/types.ts";
import type { SiteProbe } from "./custom-monitor.ts";
import type { Probe, ProbeOutcome } from "./runner.ts";

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

async function probeOnce(body: ProbeRequest, signal?: AbortSignal): Promise<ProbeOutcome> {
	let response: ProbeResponse;
	try {
		const res = await post("/api/probe", body, signal);
		if (!res.ok) {
			const f = await failure(res);
			return { kind: "stop", status: f.status, message: f.message, retryAfterSec: f.retryAfterSec };
		}
		response = await res.json();
	} catch (err) {
		if (signal?.aborted) throw err;
		return { kind: "network_error" };
	}
	return { kind: "response", response };
}

// One seed per run: every call of the run asks the same generated question, so the ladder samples the model on one instance.
export function makeProbe(target: Target, model: string, seed: number): Probe {
	return (args, signal) => probeOnce({ ...target, model, seed, ...args }, signal);
}

// No runId, so the Worker answers without persisting anything for these calls. No seed either, so generated questions use the sample seed.
export const probeSite: SiteProbe = (body) => probeOnce(body);

export const fetchHistory = (t: Target) => postJson<HistoryResponse>("/api/history", t);
export const fetchHistoryRaw = (t: Target, runId: string) => postJson<HistoryRawResponse>("/api/history/raw", { ...t, runId });
export const deleteHistory = (t: Target) => postJson<{ deleted: boolean }>("/api/history/delete", t);

import type { ApiError, HistoryRawResponse, HistoryResponse, ProbeRequest, ProbeResponse, QuestionListItem } from "../shared/types.ts";
import type { BoardAdoptResponse, BoardMoveResponse, BoardViewResponse, WatchCreateRequest, WatchCreateResponse, WatchView } from "../shared/watch.ts";
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

export type CreateFailure = { error: string; message: string; field?: "site" | "key" | "model" };

export async function createWatch(
	request: WatchCreateRequest,
): Promise<{ ok: true; value: WatchCreateResponse } | { ok: false; error: CreateFailure }> {
	const res = await post("/api/watch", request);
	if (res.ok) return { ok: true, value: await res.json() };
	const body: Partial<CreateFailure> = await res.json().catch(() => ({}));
	return {
		ok: false,
		error: { error: body.error ?? "bad_request", message: body.message ?? `接口返回 ${res.status}`, ...(body.field ? { field: body.field } : {}) },
	};
}

// Null means the watch is gone (404); a thrown error is a network or rate-limit failure the caller can retry.
export async function fetchWatch(token: string): Promise<WatchView | null> {
	const res = await post("/api/watch/view", { token });
	if (res.status === 404) return null;
	if (!res.ok) throw await failure(res);
	return res.json();
}

export async function setWatchState(token: string, action: "pause" | "resume"): Promise<WatchView | null> {
	const res = await post("/api/watch/state", { token, action });
	if (res.status === 404) return null;
	if (!res.ok) throw await failure(res);
	return res.json();
}

export async function deleteWatch(token: string): Promise<void> {
	const res = await post("/api/watch/delete", { token });
	if (!res.ok) throw await failure(res);
}

export async function fetchBoardView(board: string): Promise<BoardViewResponse> {
	const res = await post("/api/board/view", { board });
	if (!res.ok) throw await failure(res);
	return res.json();
}

export async function adoptBoard(board: string | undefined, tokens: string[]): Promise<BoardAdoptResponse> {
	const res = await post("/api/board/adopt", { ...(board ? { board } : {}), tokens });
	if (!res.ok) throw await failure(res);
	return res.json();
}

export async function moveBoard(from: string, into?: string): Promise<BoardMoveResponse> {
	const res = await post("/api/board/move", { from, ...(into ? { into } : {}) });
	if (!res.ok) throw await failure(res);
	return res.json();
}

export const fetchHistory = (t: Target) => postJson<HistoryResponse>("/api/history", t);
export const fetchHistoryRaw = (t: Target, runId: string) => postJson<HistoryRawResponse>("/api/history/raw", { ...t, runId });
export const deleteHistory = (t: Target) => postJson<{ deleted: boolean }>("/api/history/delete", t);

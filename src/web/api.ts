import type {
	ApiError,
	CustomQuestion,
	Effort,
	HistoryRawResponse,
	HistoryResponse,
	ModelsResponse,
	ProbeOk,
	ProbeRequest,
	ProbeResponse,
	Protocol,
	QuestionListItem,
} from "../shared/types.ts";
import type { BoardAdoptResponse, BoardMoveResponse, BoardOrderResponse, BoardViewResponse, WatchCreateRequest, WatchCreateResponse, WatchView } from "../shared/watch.ts";
import { FAILURE_ADVICE, failureAdvice } from "./results.ts";
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

export function missingFields(target: Target, model: string): string[] {
	return [target.site.trim() === "" && "站点", target.key === "" && "密钥", model.trim() === "" && "模型"].filter((f) => f !== false);
}

type CustomProbeRequest = Omit<ProbeRequest, "question" | "runId" | "stage" | "seq" | "attempt" | "seed"> & { custom: CustomQuestion };

async function probeOnce(body: ProbeRequest | CustomProbeRequest, signal?: AbortSignal): Promise<ProbeOutcome> {
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

// Runs only from its own tab as one call without runId, so it stays out of history and gets the worker's long-answer limits.
export const HTML_QUESTION = "pelican-svg";

export function probeHtml(target: Target, model: string, protocol: Protocol, effort: Effort | null, seed: number, signal: AbortSignal): Promise<ProbeOutcome> {
	return probeOnce({ ...target, model, protocol, question: HTML_QUESTION, seed, ...(effort && { effort }) }, signal);
}

export const MAX_CUSTOM_PROMPT = 2000;
export const MAX_CUSTOM_EXPECTED = 500;

export type CustomDraft = { prompt: string; scorerType: CustomQuestion["scorer"]["type"]; yesNo: "YES" | "NO"; contains: string };

// A null error means a field is still empty: the button stays disabled without nagging before the user has typed.
export type CustomCheck =
	| { ok: true; question: CustomQuestion }
	| { ok: false; error: { field: "prompt" | "expected"; message: string } | null };

export const codePoints = (value: string): number => [...value].length;

export function checkCustom(draft: CustomDraft): CustomCheck {
	const promptLength = codePoints(draft.prompt);
	if (promptLength > MAX_CUSTOM_PROMPT) {
		return { ok: false, error: { field: "prompt", message: `题面最多 ${MAX_CUSTOM_PROMPT} 个字符，现在 ${promptLength} 个` } };
	}
	const expectedLength = codePoints(draft.contains);
	if (draft.scorerType === "contains" && expectedLength > MAX_CUSTOM_EXPECTED) {
		return { ok: false, error: { field: "expected", message: `子串最多 ${MAX_CUSTOM_EXPECTED} 个字符，现在 ${expectedLength} 个` } };
	}
	if (promptLength === 0 || (draft.scorerType === "contains" && expectedLength === 0)) return { ok: false, error: null };
	const scorer: CustomQuestion["scorer"] =
		draft.scorerType === "yes_no" ? { type: "yes_no", expected: draft.yesNo } : { type: "contains", expected: draft.contains };
	return { ok: true, question: { prompt: draft.prompt, scorer } };
}

export function probeCustom(target: Target, model: string, protocol: Protocol, custom: CustomQuestion): Promise<ProbeOutcome> {
	return probeOnce({ ...target, model, protocol, custom });
}

export type CustomResult = { state: "ok" | "wrong"; label: "答对" | "答错"; response: ProbeOk } | { state: "fail"; label: "失败"; reason: string };

export function customResult(outcome: ProbeOutcome): CustomResult {
	if (outcome.kind === "network_error") {
		const { reason, next } = failureAdvice([]);
		return { state: "fail", label: "失败", reason: `${reason}，${next}` };
	}
	if (outcome.kind === "stop") return { state: "fail", label: "失败", reason: outcome.message };
	const { response } = outcome;
	if (!response.ok) {
		const { reason, next } = FAILURE_ADVICE[response.reason];
		return { state: "fail", label: "失败", reason: `${reason}，${next}` };
	}
	return response.correct === false ? { state: "wrong", label: "答错", response } : { state: "ok", label: "答对", response };
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

export async function orderBoard(board: string, tokens: string[]): Promise<BoardOrderResponse> {
	const res = await post("/api/board/order", { board, tokens });
	if (!res.ok) throw await failure(res);
	return res.json();
}

export async function fetchModels(t: Target, signal?: AbortSignal): Promise<ModelsResponse> {
	const res = await post("/api/models", t, signal);
	if (!res.ok) throw await failure(res);
	return res.json();
}

export const fetchHistory = (t: Target) => postJson<HistoryResponse>("/api/history", t);
export const fetchHistoryRaw = (t: Target, runId: string) => postJson<HistoryRawResponse>("/api/history/raw", { ...t, runId });
export const deleteHistory = (t: Target) => postJson<{ deleted: boolean }>("/api/history/delete", t);

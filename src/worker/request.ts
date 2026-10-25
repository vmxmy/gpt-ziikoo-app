import { getQuestion, instantiate, SAMPLE_SEED } from "../../questions/index.ts";
import type { CustomQuestion, Effort, Protocol, Question } from "../shared/types.ts";
import { BOARD_MAX_WATCHES, isWatchInterval, WATCH_MAX_ALIAS, type WatchIntervalMin } from "../shared/watch.ts";
import { parseSite } from "./target-url.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

export type RunRef = { runId: string; stage: number; seq: number; attempt: number };

export type ProbeCommand = {
	origin: string;
	host: string;
	key: string;
	protocol: Protocol;
	model: string;
	question: Question;
	effort: Effort | null;
	seed: number | null;
	run: RunRef | null;
};

export type HistoryCommand = { origin: string; key: string };

const PROTOCOLS: readonly Protocol[] = ["responses", "chat"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No character JSON or HTML encoders escape: redact() matches the key literally, so an escaped echo would slip through.
const KEY = /^[A-Za-z0-9_.-]{8,1024}$/;
const MAX_MODEL_LENGTH = 100;
const MAX_SEED = 4294967295;
const MAX_CUSTOM_PROMPT = 2000;
const MAX_CUSTOM_EXPECTED = 500;

function bad<T>(message: string): Result<T> {
	return { ok: false, message };
}

function fields(body: unknown): Record<string, unknown> | null {
	return typeof body === "object" && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : null;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return values.some((v) => v === value);
}

function isIntIn(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseTarget(f: Record<string, unknown>): Result<HistoryCommand & { host: string }> {
	const site = typeof f.site === "string" ? parseSite(f.site) : null;
	if (!site?.ok) return bad("site 不合法：只接受 https 域名");
	if (typeof f.key !== "string" || !KEY.test(f.key)) return bad("key 必须是 8 到 1024 个字母、数字或 _ . - 字符");
	return { ok: true, value: { origin: site.origin, host: site.host, key: f.key } };
}

function inCodePoints(value: string, max: number): boolean {
	const n = [...value].length;
	return n >= 1 && n <= max;
}

function parseCustom(raw: unknown): Result<CustomQuestion> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("custom 必须是对象");
	const { prompt, scorer } = raw as Record<string, unknown>;
	if (typeof prompt !== "string" || !inCodePoints(prompt, MAX_CUSTOM_PROMPT)) {
		return bad(`custom.prompt 必须是 1 到 ${MAX_CUSTOM_PROMPT} 个码位的字符串`);
	}
	if (typeof scorer !== "object" || scorer === null || Array.isArray(scorer)) return bad("custom.scorer 只接受 yes_no 或 contains");
	const { type, expected } = scorer as Record<string, unknown>;
	if (type === "yes_no" && (expected === "YES" || expected === "NO")) return { ok: true, value: { prompt, scorer: { type, expected } } };
	if (type === "contains" && typeof expected === "string" && inCodePoints(expected, MAX_CUSTOM_EXPECTED)) {
		return { ok: true, value: { prompt, scorer: { type, expected } } };
	}
	if (type === "yes_no" || type === "contains") return bad(type === "contains" ? `contains 的 expected 必须是 1 到 ${MAX_CUSTOM_EXPECTED} 个码位的字符串` : "yes_no 的 expected 必须是 YES 或 NO");
	return bad("custom.scorer 只接受 yes_no 或 contains");
}

function customQuestion({ prompt, scorer }: CustomQuestion): Question {
	return {
		id: "custom",
		version: 0,
		status: "active",
		title: "",
		measures: "",
		kind: "knowledge",
		scorer,
		expectedLabel: "",
		calibratedModels: [],
		failureHint: "",
		prompt,
	};
}

function parseRun(f: Record<string, unknown>): Result<RunRef | null> {
	const { runId, stage, seq, attempt } = f;
	if (stage !== undefined && !isIntIn(stage, 1, 4)) return bad("stage 必须是 1 到 4 的整数");
	if (seq !== undefined && !isIntIn(seq, 1, 15)) return bad("seq 必须是 1 到 15 的整数");
	if (attempt !== undefined && !isIntIn(attempt, 1, 3)) return bad("attempt 必须是 1 到 3 的整数");
	if (runId === undefined) return { ok: true, value: null };
	if (typeof runId !== "string" || !UUID.test(runId)) return bad("runId 必须是 UUID");
	if (stage === undefined || seq === undefined) return bad("带 runId 时必须同时给出 stage 与 seq");
	return { ok: true, value: { runId, stage, seq, attempt: attempt ?? 1 } };
}

export function parseProbeRequest(body: unknown): Result<ProbeCommand> {
	const f = fields(body);
	if (!f) return bad("请求体必须是 JSON 对象");
	const target = parseTarget(f);
	if (!target.ok) return target;
	const { protocol, model, effort, seed, custom } = f;
	if (!isOneOf(PROTOCOLS, protocol)) return bad("protocol 必须是 responses 或 chat");
	if (typeof model !== "string" || model.trim() === "" || model.length > MAX_MODEL_LENGTH) {
		return bad("model 必须是 1 到 100 个字符");
	}
	if (effort !== undefined && !isOneOf(EFFORTS, effort)) return bad("effort 必须是 low、medium 或 high");
	if (custom !== undefined && f.question !== undefined) return bad("question 与 custom 只能给一个");
	if (custom !== undefined) {
		const parsedCustom = parseCustom(custom);
		if (!parsedCustom.ok) return parsedCustom;
		if (f.runId !== undefined) return bad("custom 请求不能带 runId");
		if (f.seed !== undefined) return bad("custom 请求不能带 seed");
		return {
			ok: true,
			value: {
				...target.value,
				protocol,
				model,
				question: customQuestion(parsedCustom.value),
				effort: effort ?? null,
				seed: null,
				run: null,
			},
		};
	}
	const question = typeof f.question === "string" ? getQuestion(f.question) : undefined;
	if (question === undefined) return bad("必须给出 question 或 custom");
	if (question.status !== "active") return bad("question 不是已登记的题");
	if (seed !== undefined && !isIntIn(seed, 0, MAX_SEED)) return bad("seed 必须是 0 到 4294967295 的整数");
	const effectiveSeed = seed ?? SAMPLE_SEED;
	const run = parseRun(f);
	if (!run.ok) return run;
	return {
		ok: true,
		value: {
			...target.value,
			protocol,
			model,
			question: instantiate(question, effectiveSeed),
			effort: effort ?? question.defaultEffort ?? null,
			seed: question.generator ? effectiveSeed : null,
			run: run.value,
		},
	};
}

export function parseHistoryRequest(body: unknown): Result<HistoryCommand> {
	const f = fields(body);
	if (!f) return bad("请求体必须是 JSON 对象");
	return parseTarget(f);
}

export type WatchField = "site" | "key" | "model";
export type WatchCreateCommand = HistoryCommand & {
	host: string;
	model: string;
	protocol: Protocol;
	intervalMin: WatchIntervalMin;
	alias: string;
	board?: string;
};
export type WatchCreateResult = { ok: true; value: WatchCreateCommand } | { ok: false; message: string; field?: WatchField };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BOARD = /^[A-Za-z0-9_-]{22}$/;

export function parseWatchCreate(body: unknown): WatchCreateResult {
	const f = fields(body);
	if (!f) return bad("请求体必须是 JSON 对象");
	if (f.consent !== true) return bad("必须同意由本站加密保存密钥");
	const site = typeof f.site === "string" ? parseSite(f.site) : null;
	if (!site?.ok) return { ok: false, message: "site 不合法：只接受 https 域名", field: "site" };
	if (typeof f.key !== "string" || !KEY.test(f.key)) {
		return { ok: false, message: "key 必须是 8 到 1024 个字母、数字或 _ . - 字符", field: "key" };
	}
	const { model, protocol, intervalMin, alias, board } = f;
	if (typeof model !== "string" || model.trim() === "" || model.length > MAX_MODEL_LENGTH) {
		return { ok: false, message: "model 必须是 1 到 100 个字符", field: "model" };
	}
	if (!isOneOf(PROTOCOLS, protocol)) return bad("protocol 必须是 responses 或 chat");
	if (!isWatchInterval(intervalMin)) return bad("intervalMin 必须是 5 或 15");
	if (alias !== undefined && typeof alias !== "string") return bad("alias 必须是字符串");
	if (board !== undefined && (typeof board !== "string" || !BOARD.test(board))) return bad("board 不合法");
	return {
		ok: true,
		value: {
			origin: site.origin,
			host: site.host,
			key: f.key,
			model,
			protocol,
			intervalMin,
			alias: (alias ?? "").trim().slice(0, WATCH_MAX_ALIAS),
			board: board ?? undefined,
		},
	};
}

export function parseWatchToken(body: unknown): Result<string> {
	const token = fields(body)?.token;
	if (typeof token !== "string" || !TOKEN.test(token)) return bad("token 不合法");
	return { ok: true, value: token };
}

export function parseWatchState(body: unknown): Result<{ token: string; action: "pause" | "resume" }> {
	const token = parseWatchToken(body);
	if (!token.ok) return token;
	const action = fields(body)?.action;
	if (action !== "pause" && action !== "resume") return bad("action 必须是 pause 或 resume");
	return { ok: true, value: { token: token.value, action } };
}

export function parseHistoryRawRequest(body: unknown): Result<HistoryCommand & { runId: string }> {
	const target = parseHistoryRequest(body);
	if (!target.ok) return target;
	const runId = fields(body)?.runId;
	if (typeof runId !== "string" || !UUID.test(runId)) return bad("runId 必须是 UUID");
	return { ok: true, value: { ...target.value, runId } };
}

export function parseBoardView(body: unknown): Result<string> {
	const board = fields(body)?.board;
	if (typeof board !== "string" || !BOARD.test(board)) return bad("board 不合法");
	return { ok: true, value: board };
}

export function parseBoardAdopt(body: unknown): Result<{ board?: string; tokens: string[] }> {
	const f = fields(body);
	if (!f) return bad("请求体必须是 JSON 对象");
	const { board, tokens } = f;
	if (board !== undefined && (typeof board !== "string" || !BOARD.test(board))) return bad("board 不合法");
	if (!Array.isArray(tokens)) return bad("tokens 必须是数组");
	if (tokens.length > BOARD_MAX_WATCHES) return bad(`tokens 最多 ${BOARD_MAX_WATCHES} 个`);
	const valid = tokens.every((t): t is string => typeof t === "string" && TOKEN.test(t));
	if (!valid) return bad("tokens 中包含不合法的令牌");
	return { ok: true, value: { board, tokens } };
}

export function parseBoardMove(body: unknown): Result<{ from: string; into?: string }> {
	const f = fields(body);
	if (!f) return bad("请求体必须是 JSON 对象");
	const { from, into } = f;
	if (typeof from !== "string" || !BOARD.test(from)) return bad("from 不合法");
	if (into !== undefined && (typeof into !== "string" || !BOARD.test(into))) return bad("into 不合法");
	return { ok: true, value: { from, into } };
}

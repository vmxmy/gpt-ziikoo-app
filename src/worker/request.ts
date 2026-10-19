import { getQuestion } from "../../questions/index.ts";
import type { Effort, Protocol, Question } from "../shared/types.ts";
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
	run: RunRef | null;
};

export type HistoryCommand = { origin: string; key: string };

const PROTOCOLS: readonly Protocol[] = ["responses", "chat"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No character JSON or HTML encoders escape: redact() matches the key literally, so an escaped echo would slip through.
const KEY = /^[A-Za-z0-9_.-]{8,1024}$/;
const MAX_MODEL_LENGTH = 100;

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
	const { protocol, model, effort } = f;
	if (!isOneOf(PROTOCOLS, protocol)) return bad("protocol 必须是 responses 或 chat");
	if (typeof model !== "string" || model.trim() === "" || model.length > MAX_MODEL_LENGTH) {
		return bad("model 必须是 1 到 100 个字符");
	}
	const question = typeof f.question === "string" ? getQuestion(f.question) : undefined;
	if (question?.status !== "active") return bad("question 不是已登记的题");
	if (effort !== undefined && !isOneOf(EFFORTS, effort)) return bad("effort 必须是 low、medium 或 high");
	const run = parseRun(f);
	if (!run.ok) return run;
	return {
		ok: true,
		value: { ...target.value, protocol, model, question, effort: effort ?? question.defaultEffort ?? null, run: run.value },
	};
}

export function parseHistoryRequest(body: unknown): Result<HistoryCommand> {
	const f = fields(body);
	if (!f) return bad("请求体必须是 JSON 对象");
	return parseTarget(f);
}

export function parseHistoryRawRequest(body: unknown): Result<HistoryCommand & { runId: string }> {
	const target = parseHistoryRequest(body);
	if (!target.ok) return target;
	const runId = fields(body)?.runId;
	if (typeof runId !== "string" || !UUID.test(runId)) return bad("runId 必须是 UUID");
	return { ok: true, value: { ...target.value, runId } };
}

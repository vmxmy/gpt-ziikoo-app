import { activeQuestions } from "../../questions/index.ts";
import { buildMonitor, MONITOR } from "../shared/monitor.ts";
import type { ApiError, HistoryDeleteResponse, HistoryResponse, Question } from "../shared/types.ts";
import { MAX_CALLS_PER_RUN, TOO_MANY_CALLS } from "./history.ts";
import { objectId } from "./identity.ts";
import { MONITOR_NAME, MONITOR_TARGET, monitorQuestions, pickQuestion, toSample } from "./monitor.ts";
import { probe, type ProbeResult } from "./probe.ts";
import {
	type HistoryCommand,
	parseHistoryRawRequest,
	parseHistoryRequest,
	parseProbeRequest,
	type ProbeCommand,
	type RunRef,
} from "./request.ts";
import { parseSite } from "./target-url.ts";

import type { Target } from "./target.ts";

export { Monitor } from "./monitor.ts";
export { Target } from "./target.ts";

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const API_HEADERS = {
	"Content-Type": "application/json",
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};
const RETRY_AFTER_SEC = 60;
const MONITOR_WINDOW_MS = (MONITOR.buckets + 1) * MONITOR.bucketMin * 60_000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...headers } });
}

function apiError(status: number, body: ApiError, headers: Record<string, string> = {}): Response {
	return json(body, status, headers);
}

async function readJson(request: Request): Promise<unknown> {
	const text = await request.text();
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function targetStub(ctx: ExecutionContext, env: Env, { origin, key }: HistoryCommand) {
	const id = await objectId(env.PEPPER, origin, key);
	return ctx.exports.Target.get(ctx.exports.Target.idFromName(id));
}

async function ipAllowed(request: Request, env: Env): Promise<boolean> {
	const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	return (await env.IP_LIMITER.limit({ key: ip })).success;
}

function rateLimited(): Response {
	return apiError(
		429,
		{ error: "rate_limited", message: "请求过于频繁", retryAfterSec: RETRY_AFTER_SEC },
		{ "Retry-After": String(RETRY_AFTER_SEC) },
	);
}

function outcome({ response }: ProbeResult): string {
	if (!response.ok) return response.reason;
	if (response.correct === null) return "unscored";
	return response.correct ? "correct" : "wrong";
}

function logProbe(cmd: ProbeCommand, result: ProbeResult): void {
	const { httpStatus, totalMs } = result.capture;
	console.log(
		JSON.stringify({ event: "probe", host: cmd.host, question: cmd.question.id, outcome: outcome(result), httpStatus, totalMs }),
	);
}

async function persist(cmd: ProbeCommand, run: RunRef, startedAt: number, result: ProbeResult, stub: DurableObjectStub<Target>) {
	const call = {
		...run,
		questionId: cmd.question.id,
		questionVersion: cmd.question.version,
		startedAt,
		protocol: cmd.protocol,
		model: cmd.model,
		effort: cmd.effort,
		...result.capture,
	};
	await stub.record(call, { allowCreate: result.response.ok }).catch((err: unknown) => {
		const error = err instanceof Error && err.message === TOO_MANY_CALLS ? TOO_MANY_CALLS : "storage_error";
		console.error(JSON.stringify({ event: "persist_failed", host: cmd.host, error }));
	});
}

const handleProbe: Handler = async (request, env, ctx) => {
	const parsed = parseProbeRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	const cmd = parsed.value;
	if (!(await ipAllowed(request, env)) || !(await env.HOST_LIMITER.limit({ key: cmd.host })).success) return rateLimited();
	const { run } = cmd;
	const stub = run ? await targetStub(ctx, env, cmd) : null;
	// Checked before the upstream call so a full run stops spending the caller's quota; record() re-checks.
	if (run && stub && (await stub.callCount(run.runId)) >= MAX_CALLS_PER_RUN) {
		return apiError(429, { error: "too_many_calls", message: `每轮最多 ${MAX_CALLS_PER_RUN} 次调用` });
	}
	const startedAt = Date.now();
	const result = await probe(cmd);
	logProbe(cmd, result);
	if (run && stub) ctx.waitUntil(persist(cmd, run, startedAt, result, stub));
	return json(result.response);
};

const handleQuestions: Handler = async () => {
	const questions: Omit<Question, "scorer">[] = activeQuestions().map(({ scorer, ...rest }) => rest);
	return json(questions);
};

const handleHistory: Handler = async (request, env, ctx) => {
	const parsed = parseHistoryRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const stub = await targetStub(ctx, env, parsed.value);
	return json({ runs: await stub.history() } satisfies HistoryResponse);
};

const handleHistoryRaw: Handler = async (request, env, ctx) => {
	const parsed = parseHistoryRawRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const stub = await targetStub(ctx, env, parsed.value);
	return new Response(await stub.raw(parsed.value.runId), { headers: API_HEADERS });
};

const handleHistoryDelete: Handler = async (request, env, ctx) => {
	const parsed = parseHistoryRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const stub = await targetStub(ctx, env, parsed.value);
	await stub.deleteAll();
	return json({ deleted: true } satisfies HistoryDeleteResponse);
};

function monitorStub(ctx: ExecutionContext) {
	return ctx.exports.Monitor.get(ctx.exports.Monitor.idFromName(MONITOR_NAME));
}

// The only cacheable route: public data, and the edge cache keeps page views off the singleton object.
// The key drops the query string so `?x=1` cannot bypass the cache.
const handleMonitor: Handler = async (request, _env, ctx) => {
	const url = new URL(request.url);
	const key = new Request(`${url.origin}${url.pathname}`);
	const cached = await caches.default.match(key);
	if (cached) return cached;
	const now = Date.now();
	const samples = await monitorStub(ctx).since(now - MONITOR_WINDOW_MS);
	const response = json(buildMonitor(samples, now, MONITOR_TARGET), 200, { "Cache-Control": "public, max-age=60" });
	ctx.waitUntil(caches.default.put(key, response.clone()));
	return response;
};

async function runMonitor(scheduledTime: number, env: Env, ctx: ExecutionContext): Promise<void> {
	if (!env.GAOXIN_KEY) {
		console.log(JSON.stringify({ event: "monitor_skipped", reason: "no_key" }));
		return;
	}
	const site = parseSite(env.MONITOR_SITE);
	if (!site.ok) throw new Error("MONITOR_SITE is not an allowed https origin");
	const question = pickQuestion(monitorQuestions(), scheduledTime);
	const result = await probe({
		origin: site.origin,
		key: env.GAOXIN_KEY,
		protocol: "responses",
		model: env.MONITOR_MODEL,
		question,
		effort: question.defaultEffort ?? null,
	});
	const { httpStatus, totalMs } = result.capture;
	console.log(
		JSON.stringify({ event: "monitor", host: site.host, question: question.id, outcome: outcome(result), httpStatus, totalMs }),
	);
	await monitorStub(ctx).record(toSample(scheduledTime, question.id, result));
}

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
	"/api/questions": { GET: handleQuestions },
	"/api/monitor": { GET: handleMonitor },
	"/api/probe": { POST: handleProbe },
	"/api/history": { POST: handleHistory },
	"/api/history/raw": { POST: handleHistoryRaw },
	"/api/history/delete": { POST: handleHistoryDelete },
};

export default {
	async fetch(request, env, ctx) {
		const route = ROUTES[new URL(request.url).pathname];
		if (!route) return apiError(404, { error: "not_found", message: "未知接口" });
		const handler = route[request.method];
		if (!handler) {
			return apiError(405, { error: "bad_request", message: "方法不允许" }, { Allow: Object.keys(route).join(", ") });
		}
		return handler(request, env, ctx);
	},
	async scheduled(controller, env, ctx) {
		await runMonitor(controller.scheduledTime, env, ctx);
	},
} satisfies ExportedHandler<Env>;

import { activeQuestions } from "../../questions/index.ts";
import type { ApiError, HistoryDeleteResponse, HistoryResponse, ProbeLine, ProbeResponse, Question } from "../shared/types.ts";
import {
	BOARD_MAX_WATCHES,
	type BoardAdoptResponse,
	type BoardMoveResponse,
	type BoardOrderResponse,
	type BoardViewResponse,
	type WatchCreateError,
	type WatchCreateResponse,
	type WatchDeleteResponse,
	type WatchView,
} from "../shared/watch.ts";
import { newBoardCode } from "./board.ts";
import { ClaudeCaseRateLimited, runClaudeCase } from "./claude-cases.ts";
import { MAX_CALLS_PER_RUN, TOO_MANY_CALLS } from "./history.ts";
import { objectId } from "./identity.ts";
import { watchLive } from "./live.ts";
import { fetchModels } from "./models.ts";
import { probe, type ProbeResult } from "./probe.ts";
import {
	type HistoryCommand,
	parseBoardAdopt,
	parseBoardMove,
	parseBoardOrder,
	parseBoardView,
	parseClaudeCaseRequest,
	parseHistoryRawRequest,
	parseHistoryRequest,
	parseProbeRequest,
	type ProbeCommand,
	type RunRef,
	parseWatchCreate,
	parseWatchState,
	parseWatchUpdate,
	parseWatchToken,
} from "./request.ts";
import type { Target } from "./target.ts";
import { hmacHex, ipHash, newToken, watchId } from "./watch.ts";

export { Board } from "./board.ts";
export { Target } from "./target.ts";
export { Watch, WatchRegistry } from "./watch.ts";

export type WorkerCtx = Pick<ExecutionContext, "waitUntil">;
export type WorkerHandler = (request: Request, env: Env, ctx: WorkerCtx) => Promise<Response>;

const API_HEADERS = {
	"Content-Type": "application/json",
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};
const RETRY_AFTER_SEC = 60;

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

async function targetStub(env: Env, { origin, key }: HistoryCommand) {
	const id = await objectId(env.PEPPER, origin, key);
	return env.TARGET.get(env.TARGET.idFromName(id));
}

const clientIp = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

async function ipAllowed(request: Request, env: Env): Promise<boolean> {
	return (await env.IP_LIMITER.limit({ key: clientIp(request) })).success;
}

async function watchStub(env: Env, token: string) {
	const id = await watchId(env.PEPPER, token);
	return { id, stub: env.WATCH.get(env.WATCH.idFromName(id)) };
}

const registryStub = (env: Env) => env.WATCH_REGISTRY.get(env.WATCH_REGISTRY.idFromName("global"));

async function boardStub(env: Env, board: string) {
	const id = await hmacHex(env.PEPPER, `board\n${board}`);
	return env.BOARD.get(env.BOARD.idFromName(id));
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
		seed: cmd.seed,
		...result.capture,
	};
	await stub.record(call, { allowCreate: result.response.ok }).catch((err: unknown) => {
		const error = err instanceof Error && err.message === TOO_MANY_CALLS ? TOO_MANY_CALLS : "storage_error";
		console.error(JSON.stringify({ event: "persist_failed", host: cmd.host, error }));
	});
}

function progressStream(cmd: ProbeCommand, settle: (result: ProbeResult) => ProbeResponse): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (line: ProbeLine) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
			send({ type: "start", timeoutMs: cmd.limits.timeoutMs });
			const result = await probe({ ...cmd, onProgress: (progress) => send({ type: "progress", ...progress }) });
			send({ type: "result", response: settle(result) });
			controller.close();
		},
	});
	return new Response(body, { headers: { ...API_HEADERS, "Content-Type": "application/x-ndjson" } });
}

export const handleProbe: WorkerHandler = async (request, env, ctx) => {
	const parsed = parseProbeRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	const cmd = parsed.value;
	if (!(await ipAllowed(request, env)) || !(await env.HOST_LIMITER.limit({ key: cmd.host })).success) return rateLimited();
	const { run } = cmd;
	const stub = run ? await targetStub(env, cmd) : null;
	// Checked before the upstream call so a full run stops spending the caller's quota; record() re-checks.
	if (run && stub && (await stub.callCount(run.runId)) >= MAX_CALLS_PER_RUN) {
		return apiError(429, { error: "too_many_calls", message: `每轮最多 ${MAX_CALLS_PER_RUN} 次调用` });
	}
	const startedAt = Date.now();
	const settle = (result: ProbeResult) => {
		logProbe(cmd, result);
		if (run && stub) ctx.waitUntil(persist(cmd, run, startedAt, result, stub));
		return result.response;
	};
	if (cmd.progress) return progressStream(cmd, settle);
	return json(settle(await probe(cmd)));
};

export const handleQuestions: WorkerHandler = async () => {
	const questions: Omit<Question, "scorer">[] = activeQuestions().map(({ scorer, ...rest }) => rest);
	return json(questions);
};

export const handleClaudeCase: WorkerHandler = async (request, env) => {
	if (!(await ipAllowed(request, env))) return rateLimited();
	const parsed = parseClaudeCaseRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	const cmd = parsed.value;
	try {
		const result = await runClaudeCase(cmd, {
			fetch: (url, init) => fetch(url, init),
			now: () => Date.now(),
			limit: () => env.HOST_LIMITER.limit({ key: cmd.host }),
		});
		console.log(JSON.stringify({ host: cmd.host, case: result.id, verdict: result.verdict, status: result.calls.at(-1)?.status ?? null, ms: result.calls.reduce((sum, call) => sum + call.ms, 0) }));
		return json(result);
	} catch (error) {
		if (error instanceof ClaudeCaseRateLimited) return rateLimited();
		throw error;
	}
};

export const handleModels: WorkerHandler = async (request, env) => {
	const parsed = parseHistoryRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	const { origin, host, key } = parsed.value;
	if (!(await ipAllowed(request, env)) || !(await env.HOST_LIMITER.limit({ key: host })).success) return rateLimited();
	const result = await fetchModels({ origin, key });
	console.log(JSON.stringify({ event: "models", host, outcome: result.ok ? "ok" : result.reason, httpStatus: result.ok ? null : result.httpStatus, count: result.ok ? result.models.length : 0 }));
	return json(result);
};

export const handleHistory: WorkerHandler = async (request, env) => {
	const parsed = parseHistoryRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const stub = await targetStub(env, parsed.value);
	return json({ runs: await stub.history() } satisfies HistoryResponse);
};

export const handleHistoryRaw: WorkerHandler = async (request, env) => {
	const parsed = parseHistoryRawRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const stub = await targetStub(env, parsed.value);
	return new Response(await stub.raw(parsed.value.runId), { headers: API_HEADERS });
};

export const handleHistoryDelete: WorkerHandler = async (request, env) => {
	const parsed = parseHistoryRequest(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const stub = await targetStub(env, parsed.value);
	await stub.deleteAll();
	return json({ deleted: true } satisfies HistoryDeleteResponse);
};

const LIMIT_MESSAGES = {
	total_limit: "本站持续监测已满，请稍后再试",
	board_limit: `一个看板最多 ${BOARD_MAX_WATCHES} 个持续监测`,
} as const;

export const handleWatchCreate: WorkerHandler = async (request, env) => {
	const parsed = parseWatchCreate(await readJson(request));
	if (!parsed.ok) {
		const { message, field } = parsed;
		return field ? json({ error: "bad_request", message, field } satisfies WatchCreateError, 400) : apiError(400, { error: "bad_request", message });
	}
	if (!(await ipAllowed(request, env))) return rateLimited();
	const cmd = parsed.value;
	const now = Date.now();
	let board = cmd.board;
	if (board) {
		const boardStubInst = await boardStub(env, board);
		const existing = await boardStubInst.list(board, now);
		if (existing.length > 0 && existing.length >= BOARD_MAX_WATCHES) {
			return json({ error: "watch_limit", message: LIMIT_MESSAGES.board_limit } satisfies WatchCreateError, 429);
		}
		if (existing.length === 0) board = undefined;
	}
	if (!board) board = newBoardCode();
	const token = newToken();
	const { id, stub } = await watchStub(env, token);
	const registry = registryStub(env);
	const reserved = await registry.reserve(id, await ipHash(env.PEPPER, clientIp(request)), cmd.host, now);
	if (reserved !== "ok") return json({ error: "watch_limit", message: LIMIT_MESSAGES[reserved] } satisfies WatchCreateError, 429);
	const created = await stub.create(cmd, id, now);
	if (created.kind === "unauthorized") {
		await registry.release(id);
		return json({ error: "bad_request", message: "站点拒绝了这个密钥", field: "key" } satisfies WatchCreateError, 400);
	}
	const boardStubInst = await boardStub(env, board);
	await boardStubInst.add(board, [token], now);
	return json({ board, token, watch: created.watch } satisfies WatchCreateResponse);
};

export const handleWatchView: WorkerHandler = async (request, env) => {
	const parsed = parseWatchToken(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const { id, stub } = await watchStub(env, parsed.value);
	const watch = await stub.view(Date.now());
	if (!watch) return apiError(404, { error: "not_found", message: "监测不存在或已过期" });
	await registryStub(env).touch(id, watch.expiresAt);
	return json(watch);
};

export const handleWatchState: WorkerHandler = async (request, env) => {
	const parsed = parseWatchState(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const { id, stub } = await watchStub(env, parsed.value.token);
	const watch = await stub.setState(parsed.value.action, Date.now());
	if (!watch) return apiError(404, { error: "not_found", message: "监测不存在或已过期" });
	await registryStub(env).touch(id, watch.expiresAt);
	return json(watch);
};

export const handleWatchUpdate: WorkerHandler = async (request, env) => {
	const parsed = parseWatchUpdate(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const { id, stub } = await watchStub(env, parsed.value.token);
	const watch = await stub.update(parsed.value.change, Date.now());
	if (!watch) return apiError(404, { error: "not_found", message: "监测不存在或已过期" });
	await registryStub(env).touch(id, watch.expiresAt);
	return json(watch);
};

export const handleWatchDelete: WorkerHandler = async (request, env) => {
	const parsed = parseWatchToken(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const { id, stub } = await watchStub(env, parsed.value);
	await stub.deleteAll();
	await registryStub(env).release(id);
	return json({ deleted: true } satisfies WatchDeleteResponse);
};

async function fetchWatchView(env: Env, token: string, now: number): Promise<WatchView | null> {
	const { id, stub } = await watchStub(env, token);
	const watch = await stub.view(now);
	if (watch) await registryStub(env).touch(id, watch.expiresAt);
	return watch;
}

export const handleBoardView: WorkerHandler = async (request, env, ctx) => {
	const parsed = parseBoardView(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const board = parsed.value;
	const now = Date.now();
	const boardStubInst = await boardStub(env, board);
	const tokens = await boardStubInst.list(board, now);
	const results = await Promise.allSettled(tokens.map((token) => fetchWatchView(env, token, now)));
	const watches: { token: string; watch: WatchView | null }[] = [];
	const toRemove: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const result = results[i]!;
		if (result.status === "fulfilled") {
			if (result.value === null) {
				toRemove.push(token);
			} else {
				watches.push({ token, watch: result.value });
			}
		} else {
			watches.push({ token, watch: null });
		}
	}
	if (toRemove.length > 0) ctx.waitUntil(boardStubInst.remove(board, toRemove, now));
	return json({ watches } satisfies BoardViewResponse);
};

export const handleBoardAdopt: WorkerHandler = async (request, env) => {
	const parsed = parseBoardAdopt(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const { board: inputBoard, tokens } = parsed.value;
	const now = Date.now();
	const valid: string[] = [];
	for (const token of tokens) {
		const view = await fetchWatchView(env, token, now).catch(() => null);
		if (view) valid.push(token);
	}
	if (valid.length === 0) return json({ board: null } satisfies BoardAdoptResponse);
	const board = inputBoard && (await (await boardStub(env, inputBoard)).list(inputBoard, now)).length > 0 ? inputBoard : newBoardCode();
	const boardStubInst = await boardStub(env, board);
	const result = await boardStubInst.add(board, valid, now);
	if (result === "full") return json({ error: "watch_limit", message: LIMIT_MESSAGES.board_limit } satisfies WatchCreateError, 429);
	return json({ board } satisfies BoardAdoptResponse);
};

export const handleBoardMove: WorkerHandler = async (request, env) => {
	const parsed = parseBoardMove(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const { from, into: inputInto } = parsed.value;
	if (from === inputInto) return json({ board: from } satisfies BoardMoveResponse);
	const now = Date.now();
	const fromStub = await boardStub(env, from);
	const fromTokens = await fromStub.list(from, now);
	if (fromTokens.length === 0) return apiError(404, { error: "not_found", message: "看板不存在或已过期" });
	const into = inputInto ?? newBoardCode();
	if (inputInto) {
		const intoStub = await boardStub(env, inputInto);
		const intoTokens = await intoStub.list(inputInto, now);
		if (intoTokens.length === 0) return apiError(404, { error: "not_found", message: "看板不存在或已过期" });
	}
	const intoStub = await boardStub(env, into);
	const result = await intoStub.add(into, fromTokens, now);
	if (result === "full") return json({ error: "watch_limit", message: LIMIT_MESSAGES.board_limit } satisfies WatchCreateError, 429);
	await fromStub.deleteAll();
	return json({ board: into } satisfies BoardMoveResponse);
};

export const handleBoardOrder: WorkerHandler = async (request, env) => {
	const parsed = parseBoardOrder(await readJson(request));
	if (!parsed.ok) return apiError(400, { error: "bad_request", message: parsed.message });
	if (!(await ipAllowed(request, env))) return rateLimited();
	const { board, tokens } = parsed.value;
	const stub = await boardStub(env, board);
	const result = await stub.reorder(board, tokens, Date.now());
	if (result === "stale") return apiError(409, { error: "stale", message: "看板已变化，请刷新后重试" });
	return json({ tokens } satisfies BoardOrderResponse);
};

const liveContext = (request: Request, env: Env) =>
	({ req: { raw: request }, env, get: () => null }) as unknown as Parameters<typeof watchLive.connect>[0];

export const handleBoardLiveGet: WorkerHandler = async (request, env) => {
	if (!(await ipAllowed(request, env))) return rateLimited();
	return watchLive.connect(liveContext(request, env));
};

export const handleBoardLivePost: WorkerHandler = async (request, env) => {
	if (!(await ipAllowed(request, env))) return rateLimited();
	return watchLive.control(liveContext(request, env));
};

// The page posts the answer HTML in after load; the sandbox CSP gives the frame an opaque origin and no network.
const FRAME_HTML = `<!doctype html><meta charset="utf-8"><script>
addEventListener("message", function once(e) {
	if (e.source !== parent || typeof e.data !== "string") return;
	removeEventListener("message", once);
	document.open();
	document.write(e.data);
	document.close();
});
</script>`;

const FRAME_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Content-Security-Policy":
		"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; sandbox allow-scripts; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

export const handleFrame: WorkerHandler = async () => new Response(FRAME_HTML, { headers: FRAME_HEADERS });

export const handleReportSave: WorkerHandler = async () =>
	apiError(501, { error: "bad_request", message: "仅支持 Void 运行时" });

export const ROUTES: Record<string, Partial<Record<string, WorkerHandler>>> = {
	"/api/frame": { GET: handleFrame },
	"/api/questions": { GET: handleQuestions },
	"/api/probe": { POST: handleProbe },
	"/api/models": { POST: handleModels },
	"/api/claude-case": { POST: handleClaudeCase },
	"/api/history": { POST: handleHistory },
	"/api/history/raw": { POST: handleHistoryRaw },
	"/api/history/delete": { POST: handleHistoryDelete },
	"/api/reports": { POST: handleReportSave },
	"/api/watch": { POST: handleWatchCreate },
	"/api/watch/view": { POST: handleWatchView },
	"/api/watch/state": { POST: handleWatchState },
	"/api/watch/update": { POST: handleWatchUpdate },
	"/api/watch/delete": { POST: handleWatchDelete },
	"/api/board/view": { POST: handleBoardView },
	"/api/board/adopt": { POST: handleBoardAdopt },
	"/api/board/move": { POST: handleBoardMove },
	"/api/board/order": { POST: handleBoardOrder },
	"/api/board/live": { GET: handleBoardLiveGet, POST: handleBoardLivePost },
};

export function handleApiFallback(request: Request): Response {
	const route = ROUTES[new URL(request.url).pathname];
	if (route) {
		return apiError(405, { error: "bad_request", message: "方法不允许" }, { Allow: Object.keys(route).join(", ") });
	}
	return apiError(404, { error: "not_found", message: "未知接口" });
}

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
} satisfies ExportedHandler<Env>;

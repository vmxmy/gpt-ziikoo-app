import { DurableObject } from "cloudflare:workers";
import { getQuestion, instantiate, watchQuestions } from "../../questions/index.ts";
import { buildMonitor, type MonitorSample } from "../shared/monitor.ts";
import type { FailReason, ProbeResponse, Protocol, Question } from "../shared/types.ts";
import { WATCH_IDLE_DAYS, WATCH_MAX_TOTAL, type WatchChange, type WatchStatus, type WatchUsage, type WatchView } from "../shared/watch.ts";
import { addRow, applyMeasure, measureDue, measureRow, summarizePerf, type MeasureRow, type MeasureState } from "./measure.ts";
import { DEFAULT_LIMITS, defaultEffort, MAX_BODY_BYTES, probe, type ProbeCapture, type ProbeInput, type ProbeLimits, type ProbeResult } from "./probe.ts";
import { readUsage, validCount } from "./parse.ts";
import type { WatchCreateCommand } from "./request.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const IDLE_MS = WATCH_IDLE_DAYS * DAY_MS;
const MAX_SAMPLES = 1440;
const RETRIES = 3;
const UNAUTHORIZED_LIMIT = 5;
const MEASURE_QUESTION = "long-prefix";
// With a hung round of 8 minutes, two calls at this limit keep a watch's newest sample within the 10 minutes before it reads as no data.
const MEASURE_LIMITS: ProbeLimits = { maxBodyBytes: MAX_BODY_BYTES, timeoutMs: 60_000 };
const TRANSIENT: readonly FailReason[] = ["timeout", "upstream_error", "bad_response"];

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function hmacHex(pepper: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function newToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const watchId = (pepper: string, token: string) => hmacHex(pepper, `watch\n${token}`);
export const ipHash = (pepper: string, ip: string) => hmacHex(pepper, `ip\n${ip}`);

type Sealed = { iv: string; data: string };

async function aesKey(secret: string): Promise<CryptoKey> {
	const raw = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
	return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string, plain: string): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), encoder.encode(plain));
	return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

export async function unseal(secret: string, { iv, data }: Sealed): Promise<string> {
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, await aesKey(secret), fromBase64(data));
	return new TextDecoder().decode(plain);
}

type WatchState = {
	id: string;
	origin: string;
	host: string;
	alias: string;
	model: string;
	protocol: Protocol;
	// A watch made before the interval list changed may still hold 15.
	intervalMin: number;
	// Absent on watches made before questions could be picked.
	questions?: string[];
	createdAt: number;
	status: WatchStatus;
	expiresAt: number;
	seq: number;
	unauthorized: number;
	sealedKey: Sealed;
	// Absent on watches made before usage was counted, until their next round.
	usage?: WatchUsage;
	// Absent while measurement is off.
	measure?: MeasureState;
};

export type WatchPlan = { kind: "purge" } | { kind: "sleep"; until: number } | { kind: "probe"; nextAt: number };

export function planWatch(state: Pick<WatchState, "status" | "expiresAt" | "intervalMin">, now: number): WatchPlan {
	if (now >= state.expiresAt) return { kind: "purge" };
	if (state.status.kind !== "running") return { kind: "sleep", until: state.expiresAt };
	return { kind: "probe", nextAt: Math.min(now + state.intervalMin * MINUTE_MS, state.expiresAt) };
}

// A shorter interval pulls the queued round in; a longer one takes over after it.
export function alarmAfterUpdate(state: Pick<WatchState, "status" | "expiresAt" | "intervalMin">, queued: number | null, now: number): number {
	if (state.status.kind !== "running") return state.expiresAt;
	return Math.min(queued ?? Infinity, now + state.intervalMin * MINUTE_MS);
}

export function toSample(ts: number, question: string, r: ProbeResponse): MonitorSample {
	if (!r.ok) return { ts, question, ok: false, correct: null, reason: r.reason, httpStatus: r.httpStatus, totalMs: null, ttfbMs: null, ttftMs: null };
	return { ts, question, ok: true, correct: r.correct, reason: null, httpStatus: null, totalMs: r.totalMs, ttfbMs: r.ttfbMs, ttftMs: r.ttftMs };
}

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

const isTransient = (r: ProbeResponse) => !r.ok && TRANSIENT.includes(r.reason);

function addAttempt(usage: WatchUsage, { usage: raw, httpStatus }: ProbeCapture): WatchUsage {
	const read = readUsage(raw);
	const promptTokens = validCount(read.promptTokens);
	const outputTokens = validCount(read.outputTokens);
	const calls = usage.calls + 1;
	if (promptTokens === null && outputTokens === null) {
		const mayBeBilled = httpStatus === null || httpStatus < 300;
		return { ...usage, calls, unmetered: usage.unmetered + (mayBeBilled ? 1 : 0) };
	}
	return {
		...usage,
		calls,
		promptTokens: usage.promptTokens + (promptTokens ?? 0),
		cachedTokens: usage.cachedTokens + (validCount(read.cachedTokens) ?? 0),
		outputTokens: usage.outputTokens + (outputTokens ?? 0),
		reasoningTokens: usage.reasoningTokens + (validCount(read.reasoningTokens) ?? 0),
	};
}

export function addUsage(usage: WatchUsage | undefined, attempts: readonly ProbeCapture[], now: number): WatchUsage {
	const start = usage ?? { since: now, calls: 0, unmetered: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
	return attempts.reduce(addAttempt, start);
}

export function watchRotation(picked: readonly string[] | undefined): Question[] {
	const all = watchQuestions();
	return picked ? all.filter((q) => picked.includes(q.id)) : all;
}

function outcome(r: ProbeResponse): string {
	if (!r.ok) return r.reason;
	if (r.correct === null) return "unscored";
	return r.correct ? "correct" : "wrong";
}

function logProbe(host: string, question: string, { response, capture }: ProbeResult): void {
	const { httpStatus, totalMs } = capture;
	console.log(JSON.stringify({ event: "watch_probe", host, question, outcome: outcome(response), httpStatus, totalMs }));
}

type ProbeTarget = Pick<WatchState, "origin" | "host" | "protocol" | "model">;

const probeInput = ({ origin, protocol, model }: ProbeTarget, key: string, question: Question, limits: ProbeLimits): ProbeInput => ({
	origin,
	key,
	protocol,
	model,
	question,
	effort: defaultEffort(question, protocol),
	limits,
});

// Each round counts against the same per-host limit as the live test, so a watch cannot be used to flood a site.
// Only failures another call can fix are retried; the sample records the site's quality, not a passing hiccup.
// A generated question is drawn anew each round: the seed 0 instance is public, so a site could prepare its answer.
export async function probeRound(
	env: Pick<Env, "HOST_LIMITER">,
	state: ProbeTarget & Pick<WatchState, "questions" | "seq">,
	key: string,
): Promise<{ question: string; response: ProbeResponse; attempts: ProbeCapture[] } | null> {
	const rotation = watchRotation(state.questions);
	const question = rotation[state.seq % rotation.length];
	if (!question) return null;
	const input = probeInput(state, key, instantiate(question, randomSeed()), DEFAULT_LIMITS);
	let response: ProbeResponse | null = null;
	let attempts: ProbeCapture[] = [];
	for (let n = 0; n <= RETRIES && (response === null || isTransient(response)); n++) {
		if (!(await env.HOST_LIMITER.limit({ key: state.host })).success) break;
		const result = await probe(input);
		logProbe(state.host, question.id, result);
		response = result.response;
		attempts = [...attempts, result.capture];
	}
	return response && { question: question.id, response, attempts };
}

// Never retried, so a measurement costs at most two calls. Without a warm cache the second call would prove nothing, so a failed first call ends it.
export async function measureCalls(env: Pick<Env, "HOST_LIMITER">, state: ProbeTarget, key: string): Promise<{ row: MeasureRow | null; attempts: ProbeCapture[] }> {
	const question = getQuestion(MEASURE_QUESTION);
	if (!question) return { row: null, attempts: [] };
	const input = probeInput(state, key, question, MEASURE_LIMITS);
	const call = async (): Promise<ProbeResult | null> => {
		if (!(await env.HOST_LIMITER.limit({ key: state.host })).success) return null;
		const result = await probe(input);
		logProbe(state.host, question.id, result);
		return result;
	};
	const warm = await call();
	if (!warm) return { row: null, attempts: [] };
	const hit = warm.response.ok ? await call() : null;
	return { row: measureRow(Date.now(), warm.response, hit?.response ?? null), attempts: [warm.capture, ...(hit ? [hit.capture] : [])] };
}

const STATE_KEY = "state";

export type WatchCreateOutcome = { kind: "created"; watch: WatchView } | { kind: "unauthorized" };

// Holds one watch: the sealed key, its schedule and a day of samples. The name is an HMAC of the token,
// so only the holder of the token can reach it; a missing object and a wrong token look the same.
export class Watch extends DurableObject<Env> {
	private async state(): Promise<WatchState | undefined> {
		return this.ctx.storage.get<WatchState>(STATE_KEY);
	}

	private samples(now: number): MonitorSample[] {
		return this.ctx.storage.sql
			.exec<{ sample: string }>("SELECT sample FROM samples WHERE ts > ? ORDER BY ts", now - DAY_MS)
			.toArray()
			.map((row): MonitorSample => JSON.parse(row.sample));
	}

	private addSample(sample: MonitorSample): void {
		const sql = this.ctx.storage.sql;
		sql.exec("INSERT INTO samples (ts, sample) VALUES (?, ?)", sample.ts, JSON.stringify(sample));
		sql.exec("DELETE FROM samples WHERE ts <= ?", sample.ts - DAY_MS);
		sql.exec("DELETE FROM samples WHERE rowid NOT IN (SELECT rowid FROM samples ORDER BY ts DESC LIMIT ?)", MAX_SAMPLES);
	}

	private toView(state: WatchState, now: number): WatchView {
		const { origin, host, alias, model, protocol, intervalMin, createdAt, status, expiresAt } = state;
		const monitor = buildMonitor(this.samples(now), now, host, intervalMin * 60);
		const questions = watchRotation(state.questions).map((q) => q.id);
		return { site: origin, host, alias, model, protocol, intervalMin, questions, createdAt, status, expiresAt, monitor, usage: state.usage ?? null, perf: state.measure ? summarizePerf(state.measure, state.seq, intervalMin, now) : null };
	}

	private async save(state: WatchState, alarmAt: number): Promise<void> {
		await this.ctx.storage.put(STATE_KEY, state);
		await this.ctx.storage.setAlarm(alarmAt);
	}

	// A key the site rejects on the first call is never stored, so a typo does not take a slot for a week.
	async create(cmd: WatchCreateCommand, id: string, now: number): Promise<WatchCreateOutcome> {
		const state: WatchState = {
			id,
			origin: cmd.origin,
			host: cmd.host,
			alias: cmd.alias,
			model: cmd.model,
			protocol: cmd.protocol,
			intervalMin: cmd.intervalMin,
			questions: cmd.questions,
			createdAt: now,
			status: { kind: "running" },
			expiresAt: now + IDLE_MS,
			seq: 1,
			unauthorized: 0,
			sealedKey: await seal(this.env.WATCH_ENC_KEY, cmd.key),
			measure: applyMeasure(undefined, cmd.measure),
		};
		const round = await probeRound(this.env, { ...state, seq: 0 }, cmd.key);
		if (round && !round.response.ok && round.response.reason === "unauthorized") return { kind: "unauthorized" };
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, sample TEXT NOT NULL)");
		if (round) this.addSample(toSample(now, round.question, round.response));
		const stored: WatchState = round ? { ...state, usage: addUsage(undefined, round.attempts, now) } : state;
		await this.save(stored, now + cmd.intervalMin * MINUTE_MS);
		return { kind: "created", watch: this.toView(stored, now) };
	}

	// Every look pushes the purge date out; a paused watch sleeps until that date, so its alarm moves too.
	async view(now: number): Promise<WatchView | null> {
		const state = await this.state();
		if (!state) return null;
		const next = { ...state, expiresAt: now + IDLE_MS };
		await this.ctx.storage.put(STATE_KEY, next);
		if (next.status.kind !== "running") await this.ctx.storage.setAlarm(next.expiresAt);
		return this.toView(next, now);
	}

	async setState(action: "pause" | "resume", now: number): Promise<WatchView | null> {
		const state = await this.state();
		if (!state) return null;
		const expiresAt = now + IDLE_MS;
		const next: WatchState =
			action === "pause"
				? { ...state, expiresAt, status: { kind: "paused" } }
				: { ...state, expiresAt, status: { kind: "running" }, unauthorized: 0 };
		await this.save(next, action === "pause" ? expiresAt : now);
		return this.toView(next, now);
	}

	async update(change: WatchChange, now: number): Promise<WatchView | null> {
		const state = await this.state();
		if (!state) return null;
		const { measure, ...schedule } = change;
		const next: WatchState = { ...state, ...schedule, measure: applyMeasure(state.measure, measure), expiresAt: now + IDLE_MS };
		await this.save(next, alarmAfterUpdate(next, await this.ctx.storage.getAlarm(), now));
		return this.toView(next, now);
	}

	async deleteAll(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const state = await this.state();
		if (!state) return this.deleteAll();
		const plan = planWatch(state, now);
		if (plan.kind === "purge") return this.deleteAll();
		if (plan.kind === "sleep") return this.ctx.storage.setAlarm(plan.until);
		// Scheduled before the call so a crash mid-round still leaves the next round queued.
		await this.ctx.storage.setAlarm(plan.nextAt);
		const key = await unseal(this.env.WATCH_ENC_KEY, state.sealedKey);
		const round = await probeRound(this.env, state, key);
		// The call can take minutes; a pause, resume or delete made meanwhile wins over its result.
		const latest = await this.state();
		if (!latest) return;
		if (!round) return this.ctx.storage.put(STATE_KEY, { ...latest, seq: latest.seq + 1 });
		const rejected = !round.response.ok && round.response.reason === "unauthorized";
		const unauthorized = rejected ? latest.unauthorized + 1 : 0;
		const status: WatchStatus =
			latest.status.kind === "running" && unauthorized >= UNAUTHORIZED_LIMIT ? { kind: "bad_key" } : latest.status;
		// Stamped at the end of the round: a hung site holds a round for minutes, and a start time would read as stale.
		this.addSample(toSample(Date.now(), round.question, round.response));
		const next: WatchState = { ...latest, seq: latest.seq + 1, unauthorized, status, usage: addUsage(latest.usage, round.attempts, now) };
		await this.ctx.storage.put(STATE_KEY, next);
		await this.runMeasure(next, key);
	}

	private async runMeasure(state: WatchState, key: string): Promise<void> {
		if (!state.measure || !measureDue(state.measure, state)) return;
		// Written before the calls, so a crash midway cannot spend them a second time.
		await this.ctx.storage.put(STATE_KEY, { ...state, measure: { ...state.measure, measuredSeq: state.seq } });
		const { row, attempts } = await measureCalls(this.env, state, key);
		// As with a round, a pause, edit or delete made during the calls wins; turned off meanwhile, the result is dropped but the spend still counts.
		const latest = await this.state();
		if (!latest) return;
		const now = Date.now();
		const measure = latest.measure && row ? addRow(latest.measure, row, now) : latest.measure;
		await this.ctx.storage.put(STATE_KEY, { ...latest, measure, usage: addUsage(latest.usage, attempts, now) });
	}
}

export type ReserveOutcome = "ok" | "total_limit";

// One row per live watch so caps can be checked without visiting every Watch object.
// Rows past their purge date are dropped on the next reserve; the Watch object purges itself.
export class WatchRegistry extends DurableObject<Env> {
	private table(): void {
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, host TEXT NOT NULL, expires_at INTEGER NOT NULL)",
		);
	}

	async reserve(id: string, ipHash: string, host: string, now: number): Promise<ReserveOutcome> {
		this.table();
		const sql = this.ctx.storage.sql;
		sql.exec("DELETE FROM watches WHERE expires_at <= ?", now);
		const total = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM watches").one().n;
		if (total >= WATCH_MAX_TOTAL) return "total_limit";
		sql.exec("INSERT INTO watches (id, ip_hash, host, expires_at) VALUES (?, ?, ?, ?)", id, ipHash, host, now + IDLE_MS);
		return "ok";
	}

	async release(id: string): Promise<void> {
		this.table();
		this.ctx.storage.sql.exec("DELETE FROM watches WHERE id = ?", id);
	}

	async touch(id: string, expiresAt: number): Promise<void> {
		this.table();
		this.ctx.storage.sql.exec("UPDATE watches SET expires_at = ? WHERE id = ?", expiresAt, id);
	}
}

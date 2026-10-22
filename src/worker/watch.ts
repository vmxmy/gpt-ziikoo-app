import { DurableObject } from "cloudflare:workers";
import { activeQuestions, instantiate, SAMPLE_SEED } from "../../questions/index.ts";
import { buildMonitor, type MonitorSample } from "../shared/monitor.ts";
import type { FailReason, ProbeResponse, Protocol } from "../shared/types.ts";
import { WATCH_IDLE_DAYS, WATCH_MAX_PER_IP, WATCH_MAX_TOTAL, type WatchIntervalMin, type WatchStatus, type WatchView } from "../shared/watch.ts";
import { probe, type ProbeResult } from "./probe.ts";
import type { WatchCreateCommand } from "./request.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const IDLE_MS = WATCH_IDLE_DAYS * DAY_MS;
const MAX_SAMPLES = 1440;
const RETRIES = 3;
const UNAUTHORIZED_LIMIT = 5;
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
	intervalMin: WatchIntervalMin;
	createdAt: number;
	status: WatchStatus;
	expiresAt: number;
	seq: number;
	unauthorized: number;
	sealedKey: Sealed;
};

export type WatchPlan = { kind: "purge" } | { kind: "sleep"; until: number } | { kind: "probe"; nextAt: number };

export function planWatch(state: Pick<WatchState, "status" | "expiresAt" | "intervalMin">, now: number): WatchPlan {
	if (now >= state.expiresAt) return { kind: "purge" };
	if (state.status.kind !== "running") return { kind: "sleep", until: state.expiresAt };
	return { kind: "probe", nextAt: Math.min(now + state.intervalMin * MINUTE_MS, state.expiresAt) };
}

export function toSample(ts: number, question: string, r: ProbeResponse): MonitorSample {
	if (!r.ok) return { ts, question, ok: false, correct: null, reason: r.reason, httpStatus: r.httpStatus, totalMs: null, ttfbMs: null, ttftMs: null };
	return { ts, question, ok: true, correct: r.correct, reason: null, httpStatus: null, totalMs: r.totalMs, ttfbMs: r.ttfbMs, ttftMs: r.ttftMs };
}

const isTransient = (r: ProbeResponse) => !r.ok && TRANSIENT.includes(r.reason);

function outcome(r: ProbeResponse): string {
	if (!r.ok) return r.reason;
	if (r.correct === null) return "unscored";
	return r.correct ? "correct" : "wrong";
}

function logProbe(host: string, question: string, { response, capture }: ProbeResult): void {
	const { httpStatus, totalMs } = capture;
	console.log(JSON.stringify({ event: "watch_probe", host, question, outcome: outcome(response), httpStatus, totalMs }));
}

// Each round counts against the same per-host limit as the live test, so a watch cannot be used to flood a site.
// Only failures another call can fix are retried; the sample records the site's quality, not a passing hiccup.
async function probeRound(env: Env, state: WatchState, key: string): Promise<{ question: string; response: ProbeResponse } | null> {
	const ids = activeQuestions().map((q) => q.id);
	const question = activeQuestions().find((q) => q.id === ids[state.seq % ids.length]);
	if (!question) return null;
	const input = {
		origin: state.origin,
		key,
		protocol: state.protocol,
		model: state.model,
		question: instantiate(question, SAMPLE_SEED),
		effort: question.defaultEffort ?? null,
	};
	let response: ProbeResponse | null = null;
	for (let n = 0; n <= RETRIES && (response === null || isTransient(response)); n++) {
		if (!(await env.HOST_LIMITER.limit({ key: state.host })).success) break;
		const result = await probe(input);
		logProbe(state.host, question.id, result);
		response = result.response;
	}
	return response && { question: question.id, response };
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
		return { site: origin, host, alias, model, protocol, intervalMin, createdAt, status, expiresAt, monitor };
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
			createdAt: now,
			status: { kind: "running" },
			expiresAt: now + IDLE_MS,
			seq: 1,
			unauthorized: 0,
			sealedKey: await seal(this.env.WATCH_ENC_KEY, cmd.key),
		};
		const round = await probeRound(this.env, { ...state, seq: 0 }, cmd.key);
		if (round && !round.response.ok && round.response.reason === "unauthorized") return { kind: "unauthorized" };
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, sample TEXT NOT NULL)");
		if (round) this.addSample(toSample(now, round.question, round.response));
		await this.save(state, now + cmd.intervalMin * MINUTE_MS);
		return { kind: "created", watch: this.toView(state, now) };
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
		const round = await probeRound(this.env, state, await unseal(this.env.WATCH_ENC_KEY, state.sealedKey));
		// The call can take minutes; a pause, resume or delete made meanwhile wins over its result.
		const latest = await this.state();
		if (!latest) return;
		if (!round) return this.ctx.storage.put(STATE_KEY, { ...latest, seq: latest.seq + 1 });
		const rejected = !round.response.ok && round.response.reason === "unauthorized";
		const unauthorized = rejected ? latest.unauthorized + 1 : 0;
		const status: WatchStatus =
			latest.status.kind === "running" && unauthorized >= UNAUTHORIZED_LIMIT ? { kind: "bad_key" } : latest.status;
		this.addSample(toSample(now, round.question, round.response));
		await this.ctx.storage.put(STATE_KEY, { ...latest, seq: latest.seq + 1, unauthorized, status });
	}
}

export type ReserveOutcome = "ok" | "ip_limit" | "total_limit";

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
		const mine = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM watches WHERE ip_hash = ?", ipHash).one().n;
		if (mine >= WATCH_MAX_PER_IP) return "ip_limit";
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

import { DurableObject } from "cloudflare:workers";
import { activeQuestions } from "../../questions/index.ts";
import { MONITOR, type MonitorSample } from "../shared/monitor.ts";
import type { Question } from "../shared/types.ts";
import type { ProbeResult } from "./probe.ts";

export const MONITOR_NAME = "gaoxin";
export const MONITOR_TARGET = "gaoxin.net.cn";

export function monitorQuestions(): Question[] {
	return activeQuestions()
		.filter((q) => q.kind !== "metrics")
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function pickQuestion<T>(items: readonly T[], scheduledTime: number): T {
	return items[Math.floor(scheduledTime / 60_000) % items.length];
}

export function toSample(ts: number, question: string, { capture }: ProbeResult): MonitorSample {
	const { ok, correct, reason, httpStatus, totalMs, ttfbMs, ttftMs } = capture;
	return { ts, question, ok, correct, reason, httpStatus, totalMs, ttfbMs, ttftMs };
}

export class Monitor extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, sample TEXT NOT NULL)");
	}

	record(sample: MonitorSample): void {
		const { sql } = this.ctx.storage;
		sql.exec("INSERT INTO samples (ts, sample) VALUES (?, ?)", sample.ts, JSON.stringify(sample));
		sql.exec("DELETE FROM samples WHERE ts < ?", Date.now() - MONITOR.retentionMs);
	}

	since(ts: number): MonitorSample[] {
		return this.ctx.storage.sql
			.exec<{ sample: string }>("SELECT sample FROM samples WHERE ts >= ? ORDER BY ts", ts)
			.toArray()
			.map((row): MonitorSample => JSON.parse(row.sample));
	}
}

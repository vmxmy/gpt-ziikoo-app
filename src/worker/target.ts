import { DurableObject } from "cloudflare:workers";
import { getQuestion } from "../../questions/index.ts";
import type { CallRecord, RawCall, RunView } from "../shared/types.ts";
import {
	buildRunViews,
	IDLE_MS,
	planWrite,
	type RawPart,
	rawCallsStream,
	type RunSummary,
	splitCall,
	TOO_MANY_CALLS,
} from "./history.ts";

// Nothing is written until the first allowed record: a constructor-side CREATE TABLE would persist
// an empty object for every random key, and without an alarm it would never be cleaned up.
export class Target extends DurableObject<Env> {
	private hasTable(): boolean {
		return this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calls'").toArray().length > 0;
	}

	callCount(runId: string): number {
		if (!this.hasTable()) return 0;
		return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE run_id = ?", runId).one().n;
	}

	async record(call: RawCall, opts: { allowCreate: boolean }): Promise<void> {
		const { sql } = this.ctx.storage;
		if (!this.hasTable()) {
			if (!opts.allowCreate) return;
			sql.exec("CREATE TABLE calls (run_id TEXT NOT NULL, started_at INTEGER NOT NULL, record TEXT NOT NULL, raw TEXT NOT NULL)");
			sql.exec("CREATE INDEX calls_run ON calls (run_id)");
		}
		const runs = sql
			.exec<RunSummary>("SELECT run_id AS runId, MIN(started_at) AS startedAt, COUNT(*) AS calls FROM calls GROUP BY run_id")
			.toArray();
		const plan = planWrite(runs, call.runId);
		if (plan.kind === "reject") throw new Error(TOO_MANY_CALLS);
		for (const runId of plan.deleteRunIds) sql.exec("DELETE FROM calls WHERE run_id = ?", runId);
		const { record, raw } = splitCall(call);
		sql.exec(
			"INSERT INTO calls (run_id, started_at, record, raw) VALUES (?, ?, ?, ?)",
			call.runId,
			call.startedAt,
			record,
			raw,
		);
		await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
	}

	history(): RunView[] {
		if (!this.hasTable()) return [];
		const records = this.ctx.storage.sql
			.exec<{ record: string }>("SELECT record FROM calls ORDER BY started_at, rowid")
			.toArray()
			.map((row): CallRecord => JSON.parse(row.record));
		return buildRunViews(records, (id) => getQuestion(id)?.kind);
	}

	// Rows are read one per pull so the whole run is never in memory; a row deleted meanwhile is skipped.
	raw(runId: string): ReadableStream<Uint8Array> {
		const { sql } = this.ctx.storage;
		const rowIds = this.hasTable()
			? sql
					.exec<{ id: number }>("SELECT rowid AS id FROM calls WHERE run_id = ? ORDER BY started_at, rowid", runId)
					.toArray()
					.map((row) => row.id)
			: [];
		function* calls(): Generator<RawCall> {
			for (const id of rowIds) {
				const [row] = sql.exec<{ record: string; raw: string }>("SELECT record, raw FROM calls WHERE rowid = ?", id).toArray();
				if (!row) continue;
				const record: CallRecord = JSON.parse(row.record);
				const raw: RawPart = JSON.parse(row.raw);
				yield { ...record, ...raw };
			}
		}
		return rawCallsStream(calls());
	}

	async deleteAll(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	async alarm(): Promise<void> {
		await this.deleteAll();
	}
}

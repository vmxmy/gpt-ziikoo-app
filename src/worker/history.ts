import { evaluateQuestion, summarizeRun } from "../shared/ladder.ts";
import type { CallRecord, Protocol, QuestionKind, QuestionMetrics, RawCall, RunView, Stat } from "../shared/types.ts";

export const MAX_RUNS = 10;
export const MAX_CALLS_PER_RUN = 200;
export const IDLE_MS = 90 * 24 * 60 * 60 * 1000;
export const TOO_MANY_CALLS = "too_many_calls";
// DO SQLite caps a row at 2 MB; the record column and run_id fit in the remaining headroom.
export const MAX_RAW_BYTES = 1_900_000;

export type RunSummary = { runId: string; startedAt: number; calls: number };
export type WritePlan = { kind: "reject" } | { kind: "write"; deleteRunIds: string[] };
export type RawPart = Pick<RawCall, "answer" | "usage" | "rawHeaders" | "rawBody" | "rawEvents">;

export function planWrite(runs: RunSummary[], runId: string): WritePlan {
	const existing = runs.find((r) => r.runId === runId);
	if (existing) return existing.calls >= MAX_CALLS_PER_RUN ? { kind: "reject" } : { kind: "write", deleteRunIds: [] };
	const excess = runs.length - (MAX_RUNS - 1);
	const oldestFirst = [...runs].sort((a, b) => a.startedAt - b.startedAt);
	return { kind: "write", deleteRunIds: oldestFirst.slice(0, Math.max(0, excess)).map((r) => r.runId) };
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

// Summaries read only the small record column; raw payloads can be 256KB per call.
// JSON escaping can grow a 256KB body past the row cap, so an oversized payload drops the raw body first, then the answer.
export function splitCall(call: RawCall): { record: string; raw: string } {
	const { answer, usage, rawHeaders, rawBody, rawEvents, ...record } = call;
	const fitting = (part: RawPart) => {
		const text = JSON.stringify(part);
		return byteLength(text) <= MAX_RAW_BYTES ? text : null;
	};
	const full: RawPart = { answer, usage, rawHeaders, rawBody, rawEvents };
	const raw = fitting(full);
	if (raw !== null) return { record: JSON.stringify(record), raw };
	const lean: RawPart = { ...full, rawBody: null, rawEvents: null };
	return { record: JSON.stringify({ ...record, truncated: true }), raw: fitting(lean) ?? JSON.stringify({ ...lean, answer: null }) };
}

// RPC caps a serialized return value at 32 MiB, below what one run's raw data can reach; a byte stream is exempt.
export function rawCallsStream(calls: Iterator<RawCall>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let separator = "";
	return new ReadableStream({
		type: "bytes",
		start(controller) {
			controller.enqueue(encoder.encode('{"calls":['));
		},
		pull(controller) {
			const next = calls.next();
			if (next.done) {
				controller.enqueue(encoder.encode("]}"));
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(separator + JSON.stringify(next.value)));
			separator = ",";
		},
	});
}

export function stat(values: number[]): Stat | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const nearestRank = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
	return { min: sorted[0], p50: nearestRank(0.5), p95: nearestRank(0.95), max: sorted[sorted.length - 1] };
}

export function questionMetrics(calls: CallRecord[]): QuestionMetrics {
	const valid = calls.filter((c) => c.ok);
	const values = (pick: (c: CallRecord) => number | null) =>
		valid.map(pick).filter((v): v is number => v !== null);
	const cacheable = valid.filter((c) => c.cachedTokens !== null && c.promptTokens !== null);
	const prompt = cacheable.reduce((sum, c) => sum + (c.promptTokens ?? 0), 0);
	const cached = cacheable.reduce((sum, c) => sum + (c.cachedTokens ?? 0), 0);
	return {
		calls: calls.length,
		validCalls: valid.length,
		totalMs: stat(values((c) => c.totalMs)),
		ttfbMs: stat(values((c) => c.ttfbMs)),
		ttftMs: stat(values((c) => c.ttftMs)),
		cacheHitRate: prompt > 0 ? cached / prompt : null,
	};
}

// The page races responses against chat, or anthropic against chat for a Claude model, and continues with the
// first of the two when both answer or neither does (design.md). This order puts that first protocol ahead in both races.
const RACE_ORDER: readonly Protocol[] = ["responses", "anthropic", "chat"];

// When both protocols answer the stage-1 race only the one the page continued with is counted.
function raceCounted(calls: CallRecord[]): CallRecord[] {
	const answered = RACE_ORDER.filter((protocol) => calls.some((c) => c.stage === 1 && c.ok && c.protocol === protocol));
	if (answered.length < 2) return calls;
	return calls.filter((c) => c.stage !== 1 || c.protocol === answered[0]);
}

// The two race calls share stage 1 and seq 1 and are stored in arbitrary order, so the latest call cannot name the protocol the page continued with.
function runProtocol(calls: CallRecord[]): Protocol {
	const protocols = new Set(calls.map((c) => c.protocol));
	if (protocols.size === 1) return calls[0].protocol;
	const answered = new Set(calls.filter((c) => c.stage === 1 && c.seq === 1 && c.ok).map((c) => c.protocol));
	const pool = answered.size > 0 ? answered : protocols;
	return RACE_ORDER.find((protocol) => pool.has(protocol)) ?? calls[0].protocol;
}

function runView(runId: string, calls: CallRecord[], kindOf: (id: string) => QuestionKind | undefined): RunView {
	const ordered = [...calls].sort((a, b) => a.startedAt - b.startedAt);
	const latest = ordered[ordered.length - 1];
	const questions = [...Map.groupBy(ordered, (c) => c.questionId)].map(([id, qCalls]) => ({
		id,
		version: qCalls[qCalls.length - 1].questionVersion,
		verdict: kindOf(id) === "metrics" ? null : evaluateQuestion(raceCounted(qCalls)),
		metrics: questionMetrics(qCalls),
	}));
	const overall = summarizeRun(questions.flatMap((q) => (q.verdict ? [q.verdict.status] : [])));
	return { runId, startedAt: ordered[0].startedAt, model: latest.model, protocol: runProtocol(ordered), overall, questions };
}

export function buildRunViews(records: CallRecord[], kindOf: (id: string) => QuestionKind | undefined): RunView[] {
	return [...Map.groupBy(records, (r) => r.runId)]
		.map(([runId, calls]) => runView(runId, calls, kindOf))
		.sort((a, b) => b.startedAt - a.startedAt);
}

import { evaluateQuestion, summarizeRun } from "../shared/ladder.ts";
import type { CallRecord, QuestionKind, QuestionMetrics, RawCall, RunView, Stat } from "../shared/types.ts";

export const MAX_RUNS = 10;
export const MAX_CALLS_PER_RUN = 200;
export const IDLE_MS = 90 * 24 * 60 * 60 * 1000;
export const TOO_MANY_CALLS = "too_many_calls";

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

// Summaries read only the small record column; raw payloads can be 256KB per call.
export function splitCall(call: RawCall): { record: CallRecord; raw: RawPart } {
	const { answer, usage, rawHeaders, rawBody, rawEvents, ...record } = call;
	return { record, raw: { answer, usage, rawHeaders, rawBody, rawEvents } };
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

// A stage-1 protocol race mixes protocols in one run, so model and protocol come from the latest call.
function runView(runId: string, calls: CallRecord[], kindOf: (id: string) => QuestionKind | undefined): RunView {
	const ordered = [...calls].sort((a, b) => a.startedAt - b.startedAt);
	const latest = ordered[ordered.length - 1];
	const questions = [...Map.groupBy(ordered, (c) => c.questionId)].map(([id, qCalls]) => ({
		id,
		version: qCalls[qCalls.length - 1].questionVersion,
		verdict: kindOf(id) === "metrics" ? null : evaluateQuestion(qCalls),
		metrics: questionMetrics(qCalls),
	}));
	const overall = summarizeRun(questions.flatMap((q) => (q.verdict ? [q.verdict.status] : [])));
	return { runId, startedAt: ordered[0].startedAt, model: latest.model, protocol: latest.protocol, overall, questions };
}

export function buildRunViews(records: CallRecord[], kindOf: (id: string) => QuestionKind | undefined): RunView[] {
	return [...Map.groupBy(records, (r) => r.runId)]
		.map(([runId, calls]) => runView(runId, calls, kindOf))
		.sort((a, b) => b.startedAt - a.startedAt);
}

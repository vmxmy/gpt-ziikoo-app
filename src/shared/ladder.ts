import type { OverallStatus, QuestionStatus, QuestionVerdict, StageResult } from "./types.ts";

export const STAGES = [
	{ calls: 1, need: 1 },
	{ calls: 5, need: 4 },
	{ calls: 10, need: 9 },
	{ calls: 15, need: 14 },
] as const;

export const MAX_ATTEMPTS = 3;

export type LadderCall = { stage: number; seq: number; attempt: number; ok: boolean; correct: boolean | null };

type SeqResult = "correct" | "wrong" | "unavailable" | "pending";

function resolveSeq(attempts: LadderCall[]): SeqResult {
	const valid = attempts.find((c) => c.ok);
	if (valid) return valid.correct ? "correct" : "wrong";
	return attempts.length >= MAX_ATTEMPTS ? "unavailable" : "pending";
}

function groupBySeq(calls: LadderCall[], stage: number): Map<number, LadderCall[]> {
	const bySeq = new Map<number, LadderCall[]>();
	for (const c of calls) {
		if (c.stage !== stage) continue;
		bySeq.set(c.seq, [...(bySeq.get(c.seq) ?? []), c]);
	}
	return bySeq;
}

function evaluateStage(calls: LadderCall[], index: number): { result: StageResult; unavailable: boolean } {
	const spec = STAGES[index]!;
	const stage = index + 1;
	const results = [...groupBySeq(calls, stage).values()].map(resolveSeq);
	const correct = results.filter((r) => r === "correct").length;
	const wrong = results.filter((r) => r === "wrong").length;
	const unavailable = results.includes("unavailable");
	const pending = spec.calls - correct - wrong;
	const failed = wrong > spec.calls - spec.need;
	const done = correct + wrong === spec.calls;
	const state = failed ? "failed" : done ? "passed" : results.length > 0 ? "running" : "waiting";
	return { result: { stage, calls: spec.calls, need: spec.need, correct, wrong, pending, state }, unavailable };
}

export function evaluateQuestion(calls: LadderCall[]): QuestionVerdict {
	const stages: StageResult[] = [];
	let status: QuestionStatus = "passed";
	let current: number = STAGES.length;
	for (let i = 0; i < STAGES.length; i++) {
		const { result, unavailable } = evaluateStage(calls, i);
		stages.push(result);
		if (status !== "passed") continue;
		if (unavailable) {
			status = "unavailable";
			current = result.stage;
		} else if (result.state === "failed") {
			status = "failed";
			current = result.stage;
		} else if (result.state !== "passed") {
			status = "incomplete";
			current = result.stage;
		}
	}
	const correct = stages.reduce((n, s) => n + s.correct, 0);
	const total = stages.reduce((n, s) => n + s.correct + s.wrong, 0);
	return { status, stage: current, correct, total, stages };
}

export function summarizeRun(statuses: QuestionStatus[]): OverallStatus {
	if (statuses.length === 0) return "incomplete";
	if (statuses.includes("unavailable")) return "unavailable";
	if (statuses.includes("incomplete")) return "incomplete";
	const passed = statuses.filter((s) => s === "passed").length;
	if (passed === statuses.length) return "all_passed";
	return passed === 0 ? "failed" : "partial";
}

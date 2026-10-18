import type { Scorer } from "../shared/types.ts";

export type ScoreResult = { correct: boolean; note: string };

type ScorerOf<K extends Scorer["type"]> = Extract<Scorer, { type: K }>;

function yesNo(answer: string, scorer: ScorerOf<"yes_no">): ScoreResult {
	const low = answer.trimStart().toLowerCase();
	const got = low.startsWith("yes") ? "YES" : low.startsWith("no") ? "NO" : "OTHER";
	return { correct: got === scorer.expected, note: got };
}

function numbers(answer: string, scorer: ScorerOf<"numbers">): ScoreResult {
	const found = new Set(answer.match(/\d+/g) ?? []);
	const missing = scorer.expected.filter((n) => !found.has(n));
	return { correct: missing.length === 0, note: missing.length === 0 ? "ok" : `missing ${JSON.stringify(missing)}` };
}

function contains(answer: string, scorer: ScorerOf<"contains">): ScoreResult {
	const correct = answer.includes(scorer.expected);
	return { correct, note: correct ? "ok" : "not found" };
}

const SCORERS: { [K in Scorer["type"]]: (answer: string, scorer: ScorerOf<K>) => ScoreResult } = {
	yes_no: yesNo,
	numbers,
	contains,
};

export function score(answer: string, scorer: Scorer): ScoreResult {
	return scoreWith(answer, scorer);
}

function scoreWith<K extends Scorer["type"]>(answer: string, scorer: ScorerOf<K>): ScoreResult {
	const fn: (answer: string, scorer: ScorerOf<K>) => ScoreResult = SCORERS[scorer.type];
	return fn(answer, scorer);
}

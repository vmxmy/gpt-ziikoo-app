import { GENERATORS } from "../shared/generators.ts";
import type { Protocol, QuestionListItem } from "../shared/types.ts";
import type { Attempt } from "./runner.ts";

// Both thresholds are uncalibrated reference values; no real site has been measured against them.
export const OVERHEAD_LIMIT_TOKENS = 50;
export const TARGETED_RATIO = 0.25;

export type UsageRow = { question: string; title: string; chars: number; calls: number; medianTokens: number | null; perChar: number | null };
export type UsageFinding = { kind: "global"; tokens: number } | { kind: "targeted"; percent: number };
export type PromptUsage = { rows: UsageRow[]; findings: UsageFinding[] };

function median(xs: readonly number[]): number | null {
	if (xs.length === 0) return null;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function usageRow(q: QuestionListItem, attempts: readonly Attempt[], seed: number, protocol: Protocol | null): UsageRow {
	const tokens = attempts.flatMap((a) =>
		a.done && a.question === q.id && (protocol === null || a.protocol === protocol) && a.response?.ok && a.response.promptTokens !== null
			? [a.response.promptTokens]
			: [],
	);
	// The worker sends the generated prompt for this seed verbatim, so its length is what the site received.
	const chars = q.generator ? GENERATORS[q.generator](seed).prompt.length : q.prompt.length;
	const medianTokens = median(tokens);
	return { question: q.id, title: q.title, chars, calls: tokens.length, medianTokens, perChar: medianTokens === null ? null : medianTokens / chars };
}

function findings(rows: readonly UsageRow[]): UsageFinding[] {
	const row = (id: string) => rows.find((r) => r.question === id);
	const thibault = row("thibault")?.medianTokens ?? null;
	const candy = row("candy")?.perChar ?? null;
	const variant = row("candy-var")?.perChar ?? null;
	return [
		...(thibault !== null && thibault > OVERHEAD_LIMIT_TOKENS ? [{ kind: "global" as const, tokens: thibault }] : []),
		...(candy !== null && variant !== null && candy > variant * (1 + TARGETED_RATIO)
			? [{ kind: "targeted" as const, percent: Math.round((candy / variant - 1) * 100) }]
			: []),
	];
}

export function promptUsage(attempts: readonly Attempt[], questions: readonly QuestionListItem[], seed: number, protocol: Protocol | null): PromptUsage {
	const rows = questions.map((q) => usageRow(q, attempts, seed, protocol));
	return { rows, findings: findings(rows) };
}

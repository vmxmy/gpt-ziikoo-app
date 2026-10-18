import type { Effort, Question, QuestionKind, QuestionMeta, Scorer } from "../src/shared/types.ts";
import candyMeta from "./candy/meta.json";
import candyPrompt from "./candy/prompt.txt?raw";
import thibaultMeta from "./thibault/meta.json";
import thibaultPrompt from "./thibault/prompt.txt?raw";

type RawMeta = Omit<QuestionMeta, "status" | "kind" | "scorer" | "defaultEffort"> & {
	status: string;
	kind: string;
	scorer?: { type: string; expected: unknown };
	defaultEffort?: string;
};

const KINDS: readonly QuestionKind[] = ["knowledge", "reasoning", "metrics"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
	return (values as readonly string[]).includes(value);
}

function parseScorer(raw: RawMeta["scorer"], id: string): Scorer | undefined {
	if (!raw) return undefined;
	const { type, expected } = raw;
	if (type === "yes_no" && (expected === "YES" || expected === "NO")) return { type, expected };
	if (type === "contains" && typeof expected === "string") return { type, expected };
	if (type === "numbers" && Array.isArray(expected) && expected.every((e): e is string => typeof e === "string")) {
		return { type, expected };
	}
	throw new Error(`question ${id}: invalid scorer`);
}

function defineQuestion(meta: RawMeta, prompt: string): Question {
	const { status, kind, defaultEffort } = meta;
	if (status !== "active" && status !== "retired") throw new Error(`question ${meta.id}: invalid status`);
	if (!isOneOf(KINDS, kind)) throw new Error(`question ${meta.id}: invalid kind`);
	if (defaultEffort !== undefined && !isOneOf(EFFORTS, defaultEffort)) {
		throw new Error(`question ${meta.id}: invalid defaultEffort`);
	}
	return { ...meta, status, kind, defaultEffort, scorer: parseScorer(meta.scorer, meta.id), prompt };
}

export const QUESTIONS: readonly Question[] = [
	defineQuestion(thibaultMeta, thibaultPrompt),
	defineQuestion(candyMeta, candyPrompt),
];

export function getQuestion(id: string): Question | undefined {
	return QUESTIONS.find((q) => q.id === id);
}

export function activeQuestions(): Question[] {
	return QUESTIONS.filter((q) => q.status === "active");
}

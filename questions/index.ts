import { GENERATORS } from "../src/shared/generators.ts";
import type { Effort, GeneratorId, Question, QuestionKind, QuestionMeta, Scorer } from "../src/shared/types.ts";
import candyMeta from "./candy/meta.json";
import candyPrompt from "./candy/prompt.txt?raw";
import candyVarMeta from "./candy-var/meta.json";
import cialloMeta from "./ciallo/meta.json";
import cialloPrompt from "./ciallo/prompt.txt?raw";
import pelicanMeta from "./pelican-svg/meta.json";
import thibaultMeta from "./thibault/meta.json";
import thibaultPrompt from "./thibault/prompt.txt?raw";

type RawMeta = Omit<QuestionMeta, "status" | "kind" | "scorer" | "generator" | "defaultEffort"> & {
	status: string;
	kind: string;
	scorer?: { type: string; expected: unknown };
	generator?: string;
	defaultEffort?: string;
};

// The listing shows this instance; a probe without a seed sends it too.
export const SAMPLE_SEED = 0;

const KINDS: readonly QuestionKind[] = ["knowledge", "reasoning", "metrics"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];

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

function isGeneratorId(value: string): value is GeneratorId {
	return Object.hasOwn(GENERATORS, value);
}

function defineQuestion(meta: RawMeta, prompt?: string): Question {
	const { status, kind, generator, defaultEffort } = meta;
	if (status !== "active" && status !== "retired") throw new Error(`question ${meta.id}: invalid status`);
	if (!isOneOf(KINDS, kind)) throw new Error(`question ${meta.id}: invalid kind`);
	if (defaultEffort !== undefined && !isOneOf(EFFORTS, defaultEffort)) {
		throw new Error(`question ${meta.id}: invalid defaultEffort`);
	}
	if (generator !== undefined) {
		if (!isGeneratorId(generator)) throw new Error(`question ${meta.id}: invalid generator`);
		return { ...meta, status, kind, generator, defaultEffort, ...GENERATORS[generator](SAMPLE_SEED) };
	}
	if (prompt === undefined) throw new Error(`question ${meta.id}: missing prompt`);
	return { ...meta, status, kind, generator, defaultEffort, scorer: parseScorer(meta.scorer, meta.id), prompt };
}

export const QUESTIONS: readonly Question[] = [
	defineQuestion(thibaultMeta, thibaultPrompt),
	defineQuestion(candyMeta, candyPrompt),
	defineQuestion(candyVarMeta),
	defineQuestion(cialloMeta, cialloPrompt),
	defineQuestion(pelicanMeta),
];

export function instantiate(question: Question, seed: number): Question {
	return question.generator ? { ...question, ...GENERATORS[question.generator](seed) } : question;
}

export function getQuestion(id: string): Question | undefined {
	return QUESTIONS.find((q) => q.id === id);
}

export function activeQuestions(): Question[] {
	return QUESTIONS.filter((q) => q.status === "active");
}

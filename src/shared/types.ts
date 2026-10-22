export type QuestionKind = "knowledge" | "reasoning" | "metrics";

export type Scorer =
	| { type: "yes_no"; expected: "YES" | "NO" }
	| { type: "numbers"; expected: string[] }
	| { type: "final_numbers"; expected: readonly string[] }
	| { type: "contains"; expected: string };

export type Effort = "low" | "medium" | "high";
export type Protocol = "responses" | "chat";
export type GeneratorId = "candy";

export type QuestionMeta = {
	id: string;
	version: number;
	status: "active" | "retired";
	title: string;
	measures: string;
	kind: QuestionKind;
	scorer?: Scorer;
	generator?: GeneratorId;
	expectedLabel: string;
	defaultEffort?: Effort;
	calibratedModels: string[];
	failureHint: string;
};

export type Question = QuestionMeta & { prompt: string };
export type QuestionListItem = Omit<Question, "scorer">;

export type IdShape = "hex" | "ft" | "base64" | "other";

export type FailReason =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "rate_limited"
	| "upstream_error"
	| "timeout"
	| "bad_response";

export type ProbeRequest = {
	site: string;
	key: string;
	protocol: Protocol;
	model: string;
	question: string;
	effort?: Effort;
	runId?: string;
	stage?: number;
	seq?: number;
	attempt?: number;
	seed?: number;
};

export type ProbeOk = {
	ok: true;
	questionVersion: number;
	correct: boolean | null;
	note: string;
	reasoningTokens: number | null;
	idShape: IdShape;
	answer: string;
	streamed: boolean;
	ttfbMs: number;
	ttftMs: number | null;
	totalMs: number;
	promptTokens: number | null;
	cachedTokens: number | null;
};

export type ProbeFail = {
	ok: false;
	reason: FailReason;
	httpStatus: number | null;
};

export type ProbeResponse = ProbeOk | ProbeFail;

export type ApiError = {
	error: "bad_request" | "rate_limited" | "too_many_calls" | "not_found" | "watch_limit";
	message: string;
	retryAfterSec?: number;
};

export type HistoryRequest = { site: string; key: string };
export type HistoryRawRequest = HistoryRequest & { runId: string };

export type CallRecord = {
	runId: string;
	questionId: string;
	questionVersion: number;
	stage: number;
	seq: number;
	attempt: number;
	startedAt: number;
	protocol: Protocol;
	model: string;
	effort: Effort | null;
	seed: number | null;
	streamed: boolean | null;
	httpStatus: number | null;
	ok: boolean;
	reason: FailReason | null;
	correct: boolean | null;
	note: string | null;
	reasoningTokens: number | null;
	idShape: IdShape | null;
	ttfbMs: number | null;
	ttftMs: number | null;
	totalMs: number | null;
	promptTokens: number | null;
	cachedTokens: number | null;
	truncated: boolean;
};

export type RawCall = CallRecord & {
	answer: string | null;
	usage: unknown;
	rawHeaders: Record<string, string> | null;
	rawBody: string | null;
	rawEvents: { t: number; data: string }[] | null;
};

export type Stat = { min: number; p50: number; p95: number; max: number };

export type QuestionMetrics = {
	calls: number;
	validCalls: number;
	totalMs: Stat | null;
	ttfbMs: Stat | null;
	ttftMs: Stat | null;
	cacheHitRate: number | null;
};

export type StageState = "passed" | "failed" | "running" | "waiting";

export type StageResult = {
	stage: number;
	calls: number;
	need: number;
	correct: number;
	wrong: number;
	pending: number;
	state: StageState;
};

export type QuestionStatus = "passed" | "failed" | "unavailable" | "incomplete";

export type QuestionVerdict = {
	status: QuestionStatus;
	stage: number;
	correct: number;
	total: number;
	stages: StageResult[];
};

export type OverallStatus = "all_passed" | "partial" | "failed" | "unavailable" | "incomplete";

export type RunView = {
	runId: string;
	startedAt: number;
	model: string;
	protocol: Protocol;
	overall: OverallStatus;
	questions: { id: string; version: number; verdict: QuestionVerdict | null; metrics: QuestionMetrics }[];
};

export type HistoryResponse = { runs: RunView[] };
export type HistoryRawResponse = { calls: RawCall[] };
export type HistoryDeleteResponse = { deleted: boolean };

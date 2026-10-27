import type { Effort, FailReason, PlayablePage, ProbeResponse, Protocol, Question, RawCall, StreamProgress } from "../shared/types.ts";
import { idShape, parseBody, progressReader, readUsage, type TimedText } from "./parse.ts";
import { redact } from "./redact.ts";
import { score } from "./scorers.ts";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
export const MAX_BODY_BYTES = 256 * 1024;
const ANSWER_PREVIEW_CHARS = 70;

export type ProbeLimits = { maxBodyBytes: number; timeoutMs: number };

export const DEFAULT_LIMITS: ProbeLimits = { maxBodyBytes: MAX_BODY_BYTES, timeoutMs: 120_000 };
// A streamed HTML page costs about 200 bytes of events per token, past the stored-call cap, and an xhigh effort
// reasons for more than five minutes first. Only unrecorded calls get these limits, so storage keeps its cap.
// Parsing peaks at about six times the body in memory, so 8MB leaves room in the isolate's 128MB.
export const LONG_ANSWER_LIMITS: ProbeLimits = { maxBodyBytes: 8 * 1024 * 1024, timeoutMs: 900_000 };
// The Messages API requires max_tokens; 32000 fits every Claude model from Opus 4 on and leaves room for an HTML page.
const ANTHROPIC_MAX_TOKENS = 32_000;
const ANTHROPIC_VERSION = "2023-06-01";

export type ProbeInput = {
	origin: string;
	key: string;
	protocol: Protocol;
	model: string;
	question: Question;
	effort: Effort | null;
	limits: ProbeLimits;
	onProgress?: (progress: StreamProgress) => void;
};

// An HTML page streams thousands of events; two lines a second keep a progress readout current.
const PROGRESS_INTERVAL_MS = 500;

export type ProbeCapture = Omit<
	RawCall,
	"runId" | "questionId" | "questionVersion" | "stage" | "seq" | "attempt" | "startedAt" | "protocol" | "model" | "effort" | "seed"
>;

export type ProbeResult = { response: ProbeResponse; capture: ProbeCapture };

export type ProbeDeps = { fetch: (url: string, init: RequestInit) => Promise<Response>; now: () => number };

const DEFAULT_DEPS: ProbeDeps = { fetch: (url, init) => fetch(url, init), now: () => Date.now() };

const EMPTY_CAPTURE: ProbeCapture = {
	streamed: null,
	httpStatus: null,
	ok: false,
	reason: null,
	correct: null,
	note: null,
	reasoningTokens: null,
	idShape: null,
	ttfbMs: null,
	ttftMs: null,
	totalMs: null,
	promptTokens: null,
	cachedTokens: null,
	truncated: false,
	answer: null,
	usage: null,
	rawHeaders: null,
	rawBody: null,
	rawEvents: null,
};

const REQUEST_BUILDERS: Record<Protocol, (input: ProbeInput) => { path: string; body: object }> = {
	responses: ({ model, question, effort }) => ({
		path: "/v1/responses",
		body: { model, input: question.prompt, stream: true, ...(effort && { reasoning: { effort } }) },
	}),
	chat: ({ model, question, effort }) => ({
		path: "/v1/chat/completions",
		body: {
			model,
			messages: [{ role: "user", content: question.prompt }],
			stream: true,
			stream_options: { include_usage: true },
			...(effort && { reasoning_effort: effort }),
		},
	}),
	anthropic: ({ model, question, effort }) => ({
		path: "/v1/messages",
		body: {
			model,
			max_tokens: ANTHROPIC_MAX_TOKENS,
			messages: [{ role: "user", content: question.prompt }],
			stream: true,
			...(effort && { thinking: { type: "adaptive" }, output_config: { effort } }),
		},
	}),
};

const AUTH_HEADERS: Record<Protocol, (key: string) => Record<string, string>> = {
	responses: (key) => ({ Authorization: `Bearer ${key}` }),
	chat: (key) => ({ Authorization: `Bearer ${key}` }),
	anthropic: (key) => ({ "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }),
};

// A question's default effort is tuned for OpenAI reasoning models; on anthropic it would switch on adaptive thinking,
// which Claude models before 4.6 reject, so only an effort the caller chose reaches them.
export function defaultEffort(question: Question, protocol: Protocol): Effort | null {
	return protocol === "anthropic" ? null : (question.defaultEffort ?? null);
}

const STATUS_REASONS: Partial<Record<number, FailReason>> = {
	401: "unauthorized",
	403: "forbidden",
	404: "not_found",
	429: "rate_limited",
};

export function statusReason(status: number): FailReason | null {
	if (status >= 200 && status < 300) return null;
	return STATUS_REASONS[status] ?? "upstream_error";
}

export function thrownReason(err: unknown): FailReason {
	return err instanceof Error && err.name === "TimeoutError" ? "timeout" : "upstream_error";
}

function headersOf(headers: Headers, key: string): Record<string, string> {
	return Object.fromEntries(
		[...headers.entries()].filter(([name]) => name !== "set-cookie").map(([name, value]) => [name, redact(value, key)]),
	);
}

async function readCapped(
	body: ReadableStream<Uint8Array> | null,
	since: () => number,
	maxBytes: number,
	onText?: (text: string) => void,
): Promise<{ chunks: TimedText[]; truncated: boolean }> {
	if (!body) return { chunks: [], truncated: false };
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const chunks: TimedText[] = [];
	let bytes = 0;
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		const piece = next.value.subarray(0, maxBytes - bytes);
		bytes += piece.byteLength;
		const text = decoder.decode(piece, { stream: true });
		chunks.push({ t: since(), text });
		onText?.(text);
		if (piece.byteLength < next.value.byteLength) {
			await reader.cancel();
			return { chunks: [...chunks, { t: since(), text: decoder.decode() }], truncated: true };
		}
	}
	return { chunks: [...chunks, { t: since(), text: decoder.decode() }], truncated: false };
}

// Any arrival is reported, not only new answer text, so a site that sends nothing but keep-alive pings while the model
// reasons still shows as connected. The switch into reasoning goes out at once rather than waiting for the next ping.
function reportProgress(onProgress: (progress: StreamProgress) => void, since: () => number): (text: string) => void {
	const read = progressReader();
	let reported = { at: since(), reasoning: false };
	onProgress({ chars: 0, reasoning: false });
	return (text) => {
		const progress = read(text);
		const at = since();
		if (progress.reasoning === reported.reasoning && at - reported.at < PROGRESS_INTERVAL_MS) return;
		reported = { at, reasoning: progress.reasoning };
		onProgress(progress);
	};
}

const lastMatch = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].at(-1);

// The last page, because a model that plans aloud writes a skeleton page before the real one.
function pageStart(answer: string): number | undefined {
	const html = lastMatch(answer, /<html/gi)?.index;
	const doctype = lastMatch(answer.slice(0, html), /<!doctype html/gi)?.index;
	if (html === undefined || doctype === undefined) return html ?? doctype;
	return /<\/html>/i.test(answer.slice(doctype, html)) ? html : doctype;
}

function playablePage(answer: string, truncated: boolean): PlayablePage | null {
	const start = pageStart(answer);
	// A bare fragment may carry <script> or <style> outside the <svg>, so it plays whole.
	if (start === undefined) return /<svg/i.test(answer) ? { html: answer, ending: truncated ? "truncated" : "closed" } : null;
	const page = answer.slice(start);
	const close = lastMatch(page, /<\/html>/gi);
	if (close) return { html: page.slice(0, close.index + close[0].length), ending: "closed" };
	return { html: page, ending: truncated ? "truncated" : "unclosed" };
}

function failed(reason: FailReason, capture: ProbeCapture): ProbeResult {
	return { response: { ok: false, reason, httpStatus: capture.httpStatus }, capture: { ...capture, ok: false, reason } };
}

type Received = { status: number; ttfbMs: number; totalMs: number };

function finish(input: ProbeInput, base: ProbeCapture, chunks: TimedText[], { status, ttfbMs, totalMs }: Received): ProbeResult {
	const parsed = parseBody(chunks, input.key);
	// The stored call keeps the raw usage, so the output count only goes to the caller.
	const { outputTokens, ...usage } = readUsage(parsed.usage);
	const answer = parsed.text.trim();
	const shape = idShape(parsed.id);
	const capture: ProbeCapture = {
		...base,
		...usage,
		ttfbMs,
		totalMs,
		streamed: parsed.streamed,
		ttftMs: parsed.ttftMs,
		answer: answer || null,
		usage: parsed.usage,
		rawBody: parsed.rawBody,
		rawEvents: parsed.rawEvents,
		truncated: base.truncated || parsed.rawDropped,
		idShape: shape,
	};
	const reason = statusReason(status) ?? (parsed.error ? "upstream_error" : answer ? null : "bad_response");
	if (reason) return failed(reason, capture);
	const { scorer } = input.question;
	const page = input.question.html ? playablePage(answer, base.truncated) : null;
	const { correct, note } = scorer ? score(answer, scorer) : { correct: null, note: "unscored" };
	return {
		response: {
			ok: true,
			questionVersion: input.question.version,
			correct,
			note,
			reasoningTokens: usage.reasoningTokens,
			outputTokens,
			idShape: shape,
			answer: [...answer].slice(0, ANSWER_PREVIEW_CHARS).join(""),
			streamed: parsed.streamed,
			ttfbMs,
			ttftMs: parsed.ttftMs,
			totalMs,
			promptTokens: usage.promptTokens,
			cachedTokens: usage.cachedTokens,
			...(page !== null && { artifact: page }),
		},
		capture: { ...capture, ok: true, correct, note },
	};
}

// One attempt, no retry: the caller (the browser's live test or a Watch object) drives retries so each attempt is a separate call.
export async function probe(input: ProbeInput, deps: ProbeDeps = DEFAULT_DEPS): Promise<ProbeResult> {
	const { path, body } = REQUEST_BUILDERS[input.protocol](input);
	const start = deps.now();
	const since = () => deps.now() - start;
	const response = await deps
		.fetch(`${input.origin}${path}`, {
			method: "POST",
			headers: {
				"User-Agent": UA,
				...AUTH_HEADERS[input.protocol](input.key),
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify(body),
			redirect: "manual",
			signal: AbortSignal.timeout(input.limits.timeoutMs),
		})
		.catch(thrownReason);
	if (typeof response === "string") return failed(response, { ...EMPTY_CAPTURE, totalMs: since() });
	const ttfbMs = since();
	const base: ProbeCapture = {
		...EMPTY_CAPTURE,
		httpStatus: response.status,
		ttfbMs,
		rawHeaders: headersOf(response.headers, input.key),
	};
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		return failed("upstream_error", { ...base, totalMs: since() });
	}
	const onText = input.onProgress && reportProgress(input.onProgress, since);
	const read = await readCapped(response.body, since, input.limits.maxBodyBytes, onText).catch(thrownReason);
	if (typeof read === "string") return failed(read, { ...base, totalMs: since() });
	return finish(input, { ...base, truncated: read.truncated }, read.chunks, {
		status: response.status,
		ttfbMs,
		totalMs: since(),
	});
}

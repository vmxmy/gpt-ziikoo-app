import type { Effort, FailReason, ProbeResponse, Protocol, Question, RawCall } from "../shared/types.ts";
import { idShape, parseBody, readUsage, type TimedText } from "./parse.ts";
import { redact } from "./redact.ts";
import { score } from "./scorers.ts";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
export const MAX_BODY_BYTES = 256 * 1024;
const ANSWER_PREVIEW_CHARS = 70;

export type ProbeLimits = { maxBodyBytes: number; timeoutMs: number };

export const DEFAULT_LIMITS: ProbeLimits = { maxBodyBytes: MAX_BODY_BYTES, timeoutMs: 120_000 };
// A streamed HTML page costs about 200 bytes of events per token, past the stored-call cap, and a high effort
// reasons for minutes first. Only unrecorded calls get these limits, so storage keeps its cap.
export const LONG_ANSWER_LIMITS: ProbeLimits = { maxBodyBytes: 2 * 1024 * 1024, timeoutMs: 300_000 };

export type ProbeInput = {
	origin: string;
	key: string;
	protocol: Protocol;
	model: string;
	question: Question;
	effort: Effort | null;
	limits: ProbeLimits;
};

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
};

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
): Promise<{ chunks: TimedText[]; truncated: boolean }> {
	if (!body) return { chunks: [], truncated: false };
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const chunks: TimedText[] = [];
	let bytes = 0;
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		const piece = next.value.subarray(0, maxBytes - bytes);
		bytes += piece.byteLength;
		chunks.push({ t: since(), text: decoder.decode(piece, { stream: true }) });
		if (piece.byteLength < next.value.byteLength) {
			await reader.cancel();
			return { chunks: [...chunks, { t: since(), text: decoder.decode() }], truncated: true };
		}
	}
	return { chunks: [...chunks, { t: since(), text: decoder.decode() }], truncated: false };
}

function failed(reason: FailReason, capture: ProbeCapture): ProbeResult {
	return { response: { ok: false, reason, httpStatus: capture.httpStatus }, capture: { ...capture, ok: false, reason } };
}

type Received = { status: number; ttfbMs: number; totalMs: number };

function finish(input: ProbeInput, base: ProbeCapture, chunks: TimedText[], { status, ttfbMs, totalMs }: Received): ProbeResult {
	const parsed = parseBody(chunks, input.key);
	const usage = readUsage(parsed.usage);
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
	const { correct, note } = scorer ? score(answer, scorer) : { correct: null, note: "unscored" };
	return {
		response: {
			ok: true,
			questionVersion: input.question.version,
			correct,
			note,
			reasoningTokens: usage.reasoningTokens,
			idShape: shape,
			answer: [...answer].slice(0, ANSWER_PREVIEW_CHARS).join(""),
			streamed: parsed.streamed,
			ttfbMs,
			ttftMs: parsed.ttftMs,
			totalMs,
			promptTokens: usage.promptTokens,
			cachedTokens: usage.cachedTokens,
			...(input.question.html && { artifact: answer }),
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
				Authorization: `Bearer ${input.key}`,
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
	const read = await readCapped(response.body, since, input.limits.maxBodyBytes).catch(thrownReason);
	if (typeof read === "string") return failed(read, { ...base, totalMs: since() });
	return finish(input, { ...base, truncated: read.truncated }, read.chunks, {
		status: response.status,
		ttfbMs,
		totalMs: since(),
	});
}

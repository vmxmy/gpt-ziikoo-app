import type { IdShape } from "../shared/types.ts";
import { redact } from "./redact.ts";

export type TimedText = { t: number; text: string };
export type SseEvent = { t: number; data: string };

export type ParsedBody = {
	streamed: boolean;
	rawBody: string | null;
	rawEvents: SseEvent[] | null;
	rawDropped: boolean;
	text: string;
	ttftMs: number | null;
	usage: unknown;
	id: string | null;
	error: boolean;
};

export type Usage = { promptTokens: number | null; cachedTokens: number | null; reasoningTokens: number | null };

const SSE_START = /^\s*(data|event|id|retry)?:/;

// First match wins. `resp_0` precedes the hex rule because the brief classifies it as base64;
// real OpenAI hex ids start with a timestamp digit, so the overlap is theoretical.
const ID_SHAPES: readonly [RegExp, IdShape][] = [
	[/^resp_ft_/, "ft"],
	[/^resp_0/, "base64"],
	[/^resp_[0-9a-f]+$/i, "hex"],
	[/^resp_[A-Za-z0-9+/_-]{32,}={0,2}$/, "base64"],
];

function get(value: unknown, ...path: (string | number)[]): unknown {
	return path.reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? Reflect.get(v, k) : undefined), value);
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): object | null {
	return typeof value === "object" && value !== null ? value : null;
}

function escapeControlCharsInStrings(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		if (inString && !escaped && code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
		else out += ch;
		if (escaped) escaped = false;
		else if (ch === "\\" && inString) escaped = true;
		else if (ch === '"') inString = !inString;
	}
	return out;
}

// Relays sometimes emit raw newlines or tabs inside JSON strings; Python's json.loads(strict=False) accepts them.
export function lenientJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		try {
			return JSON.parse(escapeControlCharsInStrings(text));
		} catch {
			return undefined;
		}
	}
}

function fullText(d: unknown): string {
	const output = get(d, "output");
	const parts = Array.isArray(output)
		? output
				.filter((o) => get(o, "type") === "message")
				.flatMap((o) => {
					const content = get(o, "content");
					return Array.isArray(content) ? content : [];
				})
				.filter((c) => get(c, "type") === "output_text")
				.map((c) => str(get(c, "text")) ?? "")
		: [];
	const blocks = get(d, "content");
	const anthropicText = Array.isArray(blocks) ? blocks.filter((b) => get(b, "type") === "text").map((b) => str(get(b, "text")) ?? "") : [];
	return parts.join("") || (str(get(d, "choices", 0, "message", "content")) ?? anthropicText.join(""));
}

function deltaText(p: unknown): string {
	if (get(p, "type") === "response.output_text.delta") return str(get(p, "delta")) ?? "";
	if (get(p, "type") === "content_block_delta") return get(p, "delta", "type") === "text_delta" ? (str(get(p, "delta", "text")) ?? "") : "";
	return str(get(p, "choices", 0, "delta", "content")) ?? "";
}

const eventUsage = (p: unknown): object | null => obj(get(p, "response", "usage")) ?? obj(get(p, "message", "usage")) ?? obj(get(p, "usage"));

function isError(p: unknown): boolean {
	const type = get(p, "type");
	return type === "error" || type === "response.failed" || get(p, "error") != null || get(p, "response", "error") != null;
}

export function readUsage(usage: unknown): Usage {
	const input = num(get(usage, "input_tokens"));
	const cacheRead = num(get(usage, "cache_read_input_tokens"));
	const cacheWrite = num(get(usage, "cache_creation_input_tokens"));
	// Anthropic's input_tokens leaves out the cached and cache-written part of the prompt; OpenAI's includes it.
	const anthropicPrompt = input !== null && (cacheRead !== null || cacheWrite !== null) ? input + (cacheRead ?? 0) + (cacheWrite ?? 0) : null;
	return {
		promptTokens: anthropicPrompt ?? input ?? num(get(usage, "prompt_tokens")),
		cachedTokens:
			cacheRead ?? num(get(usage, "input_tokens_details", "cached_tokens")) ?? num(get(usage, "prompt_tokens_details", "cached_tokens")),
		reasoningTokens:
			num(get(usage, "output_tokens_details", "reasoning_tokens")) ??
			num(get(usage, "completion_tokens_details", "reasoning_tokens")),
	};
}

export function idShape(id: string | null): IdShape {
	if (id === null) return "other";
	return ID_SHAPES.find(([pattern]) => pattern.test(id))?.[1] ?? "other";
}

function splitEvents(chunks: TimedText[], key: string): SseEvent[] {
	const events: SseEvent[] = [];
	let buffer = "";
	let lastT = 0;
	for (const { t, text } of chunks) {
		buffer = (buffer + text).replace(/\r\n/g, "\n");
		lastT = t;
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const block = buffer.slice(0, end);
			if (block.trim()) events.push({ t, data: redact(block, key) });
			buffer = buffer.slice(end + 2);
		}
	}
	if (buffer.trim()) events.push({ t: lastT, data: redact(buffer, key) });
	return events;
}

function eventPayload(block: string): unknown {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n");
	return data === "" || data === "[DONE]" ? undefined : lenientJson(data);
}

// Counts answer characters chunk by chunk while the body is still arriving; parseBody reads the whole body again at the end.
export function answerCounter(): (text: string) => number {
	let buffer = "";
	let chars = 0;
	return (text) => {
		buffer = (buffer + text).replace(/\r\n/g, "\n");
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const p = eventPayload(buffer.slice(0, end));
			chars += p === undefined ? 0 : deltaText(p).length;
			buffer = buffer.slice(end + 2);
		}
		return chars;
	};
}

function parseSse(chunks: TimedText[], key: string): ParsedBody {
	const events = splitEvents(chunks, key);
	let text = "";
	let ttftMs: number | null = null;
	let usage: object | null = null;
	let id: string | null = null;
	let error = false;
	let completedText = "";
	for (const event of events) {
		const p = eventPayload(event.data);
		if (p === undefined) continue;
		const delta = deltaText(p);
		if (delta) {
			text += delta;
			ttftMs ??= event.t;
		}
		id ??= str(get(p, "response", "id")) ?? str(get(p, "message", "id")) ?? str(get(p, "id"));
		// Anthropic reports input usage in message_start and output usage in message_delta, so later fields join earlier ones.
		const found = eventUsage(p);
		if (found) usage = { ...(usage ?? {}), ...found };
		error ||= isError(p);
		if (get(p, "type") === "response.completed") completedText = fullText(get(p, "response"));
	}
	// Per-event redaction misses a key the tokenizer split across deltas. The events are dropped rather than rewritten:
	// mapping the key's span in the joined text back onto delta substrings is fragile, and an echoed key is already abnormal.
	const joined = text || completedText;
	const answer = redact(joined, key);
	const rawDropped = answer !== joined;
	return {
		streamed: true,
		rawBody: null,
		rawEvents: rawDropped ? null : events,
		rawDropped,
		text: answer,
		ttftMs,
		usage,
		id,
		error,
	};
}

// A key the relay wrote with \uXXXX escapes survives the byte-level redaction and only appears after JSON.parse.
function parseWhole(body: string, key: string): ParsedBody {
	const d = lenientJson(body);
	const joined = fullText(d);
	const text = redact(joined, key);
	const rawDropped = text !== joined;
	return {
		streamed: false,
		rawBody: rawDropped ? null : body,
		rawEvents: null,
		rawDropped,
		text,
		ttftMs: null,
		usage: obj(get(d, "usage")),
		id: str(get(d, "id")),
		error: get(d, "error") != null,
	};
}

// Sniffed from the body, not Content-Type: relays that ignore `stream` often keep the SSE header or omit it.
export function parseBody(chunks: TimedText[], key: string): ParsedBody {
	const whole = chunks.map((c) => c.text).join("");
	return SSE_START.test(whole) ? parseSse(chunks, key) : parseWhole(redact(whole, key), key);
}

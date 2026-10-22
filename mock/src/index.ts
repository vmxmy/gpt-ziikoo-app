import { solveBag } from "../../src/shared/candy-gen.ts";

type Protocol = "responses" | "chat";
type IdKind = "hex" | "ft" | "b64";
type Topic = "thibault" | "candy" | "candy-var" | "ciallo";
type Answering = {
	kind: "answer";
	correct: boolean;
	wrongFor: ReadonlySet<Topic>;
	honorStream: boolean;
	id: IdKind;
	cached: boolean;
	gapMs: number;
	big: boolean;
	empty: boolean;
	// Extra input tokens reported per topic, as a relay that injects hidden instructions would bill them.
	extraInput: Partial<Record<Topic, number>>;
};
type Failing = { kind: "fail"; status: number; echo: boolean };
// Replies that are not OpenAI-shaped at all, as relays behind a WAF or a broken proxy send them.
type Canned = { kind: "canned"; reply: () => Response };
type Behavior = Answering | Failing | Canned;
type Frame = { delayMs: number; text: string };

type Completion = {
	protocol: Protocol;
	model: string;
	id: string;
	messageId: string;
	reasoningId: string | null;
	created: number;
	text: string;
	usage: object;
	gapMs: number;
	includeUsage: boolean;
};

const FIRST_TOKEN_DELAY_MS = 80;
const BIG_FILLER_CHARS = 300 * 1024;
const DELTA_CHARS = 8;
const BIG_DELTA_CHARS = 1024;

const ANSWER: Answering = {
	kind: "answer",
	correct: true,
	wrongFor: new Set<Topic>(),
	honorStream: true,
	id: "hex",
	cached: false,
	gapMs: 0,
	big: false,
	empty: false,
	extraInput: {},
};

const BLOCK_PAGE = "<!DOCTYPE html><html><head><title>Access denied</title></head><body><h1>403 Forbidden</h1></body></html>";

function html(body: string, status: number): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function sseEvent(type: string, fields: object, sequence: number): Frame {
	return { delayMs: 0, text: `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...fields })}\n\n` };
}

function streamFailure(): Response {
	const response = { id: `resp_68${hex(23)}`, object: "response", status: "in_progress", error: null, output: [], usage: null };
	const frames = [
		sseEvent("response.created", { response }, 0),
		sseEvent("error", { code: "server_error", message: "The server had an error while processing your request.", param: null }, 1),
	];
	return new Response(streamOf(frames), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

const MODELS = new Map<string, Behavior>([
	["mock-good", ANSWER],
	["mock-wrong", { ...ANSWER, correct: false }],
	["mock-partial", { ...ANSWER, wrongFor: new Set<Topic>(["candy"]) }],
	["mock-nostream", { ...ANSWER, honorStream: false }],
	["mock-ft", { ...ANSWER, id: "ft" }],
	["mock-b64", { ...ANSWER, id: "b64" }],
	["mock-cached", { ...ANSWER, cached: true }],
	["mock-slow", { ...ANSWER, gapMs: 400 }],
	["mock-big", { ...ANSWER, big: true }],
	["mock-empty", { ...ANSWER, empty: true }],
	["mock-inject-candy", { ...ANSWER, correct: false, extraInput: { candy: 300 } }],
	["mock-inject-all", { ...ANSWER, correct: false, extraInput: { thibault: 200, candy: 200, "candy-var": 200 } }],
	["mock-401", { kind: "fail", status: 401, echo: false }],
	["mock-429", { kind: "fail", status: 429, echo: false }],
	["mock-500", { kind: "fail", status: 500, echo: false }],
	["mock-echo", { kind: "fail", status: 500, echo: true }],
	["mock-403", { kind: "canned", reply: () => html(BLOCK_PAGE, 403) }],
	["mock-html", { kind: "canned", reply: () => html("<html><body>OK</body></html>", 200) }],
	// Points back at this mock so a worker that followed it would report 200, not the 302 itself.
	["mock-redirect", { kind: "canned", reply: () => new Response(null, { status: 302, headers: { Location: "/healthz" } }) }],
	["mock-stream-error", { kind: "canned", reply: streamFailure }],
	// No timeout model: it would hold a probe for 120 seconds. test/worker/probe.test.ts covers that path.
]);

const PATHS = new Map<string, Protocol>([
	["/v1/responses", "responses"],
	["/v1/chat/completions", "chat"],
]);

const VALID_AUTH = /^Bearer sk-\S{5,}$/;

const CANDY_VAR_MARKER = "最后一行严格按此格式写：答案：";

// Reads the bag back out of the generated prompt: the tab-separated table and pairing line 1.
function solveCandyVar(prompt: string): { right: string; wrong: string } {
	const lines = prompt.split("\n");
	const [header, ...rows] = lines.filter((l) => l.includes("\t")).map((l) => l.split("\t"));
	const hidden = header.slice(1);
	const [pairing] = lines.filter((l) => l.startsWith("1. "));
	const [first, second] = pairing.split("，和");
	const [a, p] = [first, second].map((half) => hidden.findIndex((h) => half.includes(h)));
	const [[t0, ...shape0], [t1, ...shape1]] = rows;
	const { total, splits } = solveBag(shape0.map(Number), shape1.map(Number), [
		[[0, a], [1, p]],
		[[0, p], [1, a]],
	]);
	const [c, s] = splits[0];
	const line = (n: number, x: number, y: number) => `答案：总数=${n}，${t0}=${x}，${t1}=${y}`;
	return {
		right: `按最坏情况逐一排除，取总数最小的组合。\n${line(total, c, s)}`,
		wrong: `按最坏情况逐一排除。\n${line(total + 1, c + 1, s)}`,
	};
}

const ANSWERS: Record<Topic, (prompt: string) => { right: string; wrong: string }> = {
	// The markup sits ahead of the worker's 70-character answer preview, so the e2e sees it intact and
	// can prove the page renders relay answers as text; yes_no scoring only reads the leading "No".
	thibault: () => ({
		right: "Yes, I know who Thibault Sottiaux is.",
		wrong: `No <b>bold</b><img src=x onerror="document.title='x'"> I don't know who that is.`,
	}),
	candy: () => ({
		right:
			"答案：至少需要摸出 21 颗糖果，其中圆形 9 颗、五角星形 12 颗。推导：按最坏情况分别计算圆形与五角星形需要摸出的数量，再取总数最小的组合，得到 9 + 12 = 21。",
		wrong: "至少需要摸出 20 颗糖果。",
	}),
	"candy-var": solveCandyVar,
	// The stock persona's greeting, as the original model replies; a swapped model answers in plain English.
	ciallo: () => ({
		right: "Ciallo～(∠・ω< )⌒☆ 今天想一起做点什么？",
		wrong: "Hello! How can I help you today?",
	}),
};

// The marker comes first: the generator can also draw 糖果 as its noun.
function topicOf(prompt: string): Topic | null {
	if (prompt.includes(CANDY_VAR_MARKER)) return "candy-var";
	if (prompt.includes("Thibault")) return "thibault";
	// The ciallo prompt is the bare word on its own line; every other prompt is a longer sentence.
	if (/^ciallo\s*$/m.test(prompt)) return "ciallo";
	return prompt.includes("糖果") ? "candy" : null;
}

const FAILURES: Record<number, { message: string; type: string; code: string | null }> = {
	401: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" },
	429: { message: "Rate limit reached for requests.", type: "requests", code: "rate_limit_exceeded" },
	500: { message: "The server had an error while processing your request.", type: "server_error", code: null },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function openAiError(status: number, message: string, type: string, code: string | null): Response {
	return json({ error: { message, type, param: null, code } }, status);
}

function hex(bytes: number): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: number): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
		.replaceAll("+", "-")
		.replaceAll("/", "_");
}

// Shapes must land on the worker's idShape rules: hex ids never start with 0 (that prefix is
// classified base64), and the leading Z keeps a base64 id from ever being all hex digits.
function responseId(protocol: Protocol, kind: IdKind): string {
	if (kind === "ft") return `resp_ft_${hex(20)}`;
	if (kind === "b64") return `resp_Z${base64url(36)}`;
	return protocol === "responses" ? `resp_68${hex(23)}` : `chatcmpl-${hex(15)}`;
}

function answerText(prompt: string, b: Answering): string {
	if (b.empty) return "";
	const topic = topicOf(prompt);
	const { right, wrong } = topic ? ANSWERS[topic](prompt) : { right: "OK", wrong: "OK" };
	const text = b.correct && !(topic && b.wrongFor.has(topic)) ? right : wrong;
	return b.big ? `${text} ${"x".repeat(BIG_FILLER_CHARS)}` : text;
}

function usageOf(protocol: Protocol, prompt: string, text: string, b: Answering): { usage: object; reasoning: number } {
	const topic = topicOf(prompt);
	const input = (b.cached ? 1280 : Math.ceil(prompt.length / 2)) + (topic ? (b.extraInput[topic] ?? 0) : 0);
	const cached = b.cached ? 1024 : 0;
	const reasoning = b.correct ? 192 : 0;
	const output = reasoning + Math.ceil(text.length / 2);
	const usage =
		protocol === "responses"
			? {
					input_tokens: input,
					input_tokens_details: { cached_tokens: cached },
					output_tokens: output,
					output_tokens_details: { reasoning_tokens: reasoning },
					total_tokens: input + output,
				}
			: {
					prompt_tokens: input,
					completion_tokens: output,
					total_tokens: input + output,
					prompt_tokens_details: { cached_tokens: cached, audio_tokens: 0 },
					completion_tokens_details: {
						reasoning_tokens: reasoning,
						audio_tokens: 0,
						accepted_prediction_tokens: 0,
						rejected_prediction_tokens: 0,
					},
				};
	return { usage, reasoning };
}

function split(text: string, size: number): string[] {
	return Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
}

function deltaDelay(index: number, gapMs: number): number {
	return index === 0 ? FIRST_TOKEN_DELAY_MS : gapMs;
}

const textPart = (text: string) => ({ type: "output_text", text, annotations: [], logprobs: [] });

const reasoningItem = (id: string) => ({ id, type: "reasoning", summary: [] });

function messageItem(c: Completion, done: boolean) {
	return {
		id: c.messageId,
		type: "message",
		status: done ? "completed" : "in_progress",
		role: "assistant",
		content: done ? [textPart(c.text)] : [],
	};
}

function responseObject(c: Completion, done: boolean) {
	const output = [...(c.reasoningId ? [reasoningItem(c.reasoningId)] : []), messageItem(c, true)];
	return {
		id: c.id,
		object: "response",
		created_at: c.created,
		status: done ? "completed" : "in_progress",
		error: null,
		incomplete_details: null,
		model: c.model,
		output: done ? output : [],
		usage: done ? c.usage : null,
	};
}

function chatObject(c: Completion) {
	return {
		id: c.id,
		object: "chat.completion",
		created: c.created,
		model: c.model,
		choices: [
			{ index: 0, message: { role: "assistant", content: c.text, refusal: null, annotations: [] }, logprobs: null, finish_reason: "stop" },
		],
		usage: c.usage,
		system_fingerprint: null,
	};
}

function responsesFrames(c: Completion, deltas: string[]): Frame[] {
	const index = c.reasoningId ? 1 : 0;
	const at = { item_id: c.messageId, output_index: index, content_index: 0 };
	const reasoning: [string, object][] = c.reasoningId
		? [
				["response.output_item.added", { output_index: 0, item: reasoningItem(c.reasoningId) }],
				["response.output_item.done", { output_index: 0, item: reasoningItem(c.reasoningId) }],
			]
		: [];
	const events: [string, object, number?][] = [
		["response.created", { response: responseObject(c, false) }],
		["response.in_progress", { response: responseObject(c, false) }],
		...reasoning,
		["response.output_item.added", { output_index: index, item: messageItem(c, false) }],
		["response.content_part.added", { ...at, part: textPart("") }],
		...deltas.map((delta, i): [string, object, number] => [
			"response.output_text.delta",
			{ ...at, delta, logprobs: [] },
			deltaDelay(i, c.gapMs),
		]),
		["response.output_text.done", { ...at, text: c.text, logprobs: [] }],
		["response.content_part.done", { ...at, part: textPart(c.text) }],
		["response.output_item.done", { output_index: index, item: messageItem(c, true) }],
		["response.completed", { response: responseObject(c, true) }],
	];
	return events.map(([type, fields, delayMs = 0], i) => ({
		delayMs,
		text: `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: i, ...fields })}\n\n`,
	}));
}

function chatFrames(c: Completion, deltas: string[]): Frame[] {
	const chunk = (choices: object[], usage: object | null = null) =>
		`data: ${JSON.stringify({
			id: c.id,
			object: "chat.completion.chunk",
			created: c.created,
			model: c.model,
			system_fingerprint: null,
			choices,
			...(c.includeUsage && { usage }),
		})}\n\n`;
	const choice = (delta: object, finish: string | null = null) => ({ index: 0, delta, logprobs: null, finish_reason: finish });
	return [
		{ delayMs: 0, text: chunk([choice({ role: "assistant", content: "", refusal: null })]) },
		...deltas.map((content, i) => ({ delayMs: deltaDelay(i, c.gapMs), text: chunk([choice({ content })]) })),
		{ delayMs: 0, text: chunk([choice({}, "stop")]) },
		...(c.includeUsage ? [{ delayMs: 0, text: chunk([], c.usage) }] : []),
		{ delayMs: 0, text: "data: [DONE]\n\n" },
	];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function streamOf(frames: Frame[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const queue = frames.values();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = queue.next();
			if (next.done) return controller.close();
			if (next.value.delayMs > 0) await sleep(next.value.delayMs);
			controller.enqueue(encoder.encode(next.value.text));
		},
	});
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function answer(protocol: Protocol, body: unknown, model: string, b: Answering): Response {
	const input = protocol === "responses" ? field(body, "input") : field(field(field(body, "messages"), "0"), "content");
	const prompt = typeof input === "string" ? input : "";
	const text = answerText(prompt, b);
	const { usage, reasoning } = usageOf(protocol, prompt, text, b);
	const c: Completion = {
		protocol,
		model,
		id: responseId(protocol, b.id),
		messageId: `msg_${hex(24)}`,
		reasoningId: reasoning > 0 ? `rs_${hex(24)}` : null,
		created: Math.floor(Date.now() / 1000),
		text,
		usage,
		gapMs: b.gapMs,
		includeUsage: field(field(body, "stream_options"), "include_usage") === true,
	};
	if (field(body, "stream") !== true || !b.honorStream) {
		return json(protocol === "responses" ? responseObject(c, true) : chatObject(c));
	}
	const deltas = split(text, b.big ? BIG_DELTA_CHARS : DELTA_CHARS);
	const frames = protocol === "responses" ? responsesFrames(c, deltas) : chatFrames(c, deltas);
	return new Response(streamOf(frames), {
		headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
	});
}

function failure(b: Failing, auth: string): Response {
	const f = FAILURES[b.status] ?? FAILURES[500]!;
	// mock-echo deliberately reflects the header so e2e can prove the app redacts what relays echo back.
	const message = b.echo ? `upstream rejected request, Authorization: ${auth}` : f.message;
	return openAiError(b.status, message, f.type, f.code);
}

async function readBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}

export default {
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/healthz") return new Response("ok");
		const protocol = PATHS.get(pathname);
		if (!protocol) return openAiError(404, "Unknown URL.", "invalid_request_error", "unknown_url");
		if (request.method !== "POST") return openAiError(405, "Method not allowed.", "invalid_request_error", null);
		const auth = request.headers.get("Authorization") ?? "";
		if (!VALID_AUTH.test(auth)) return failure({ kind: "fail", status: 401, echo: false }, auth);
		const body = await readBody(request);
		if (body === undefined) {
			return openAiError(400, "We could not parse the JSON body of your request.", "invalid_request_error", null);
		}
		const model = field(body, "model");
		const behavior = typeof model === "string" ? MODELS.get(model) : undefined;
		if (typeof model !== "string" || !behavior) {
			return openAiError(404, "The model does not exist or you do not have access to it.", "invalid_request_error", "model_not_found");
		}
		if (behavior.kind === "canned") return behavior.reply();
		return behavior.kind === "fail" ? failure(behavior, auth) : answer(protocol, body, model, behavior);
	},
} satisfies ExportedHandler;

import { describe, expect, it } from "vitest";
import { getQuestion } from "../../questions/index.ts";
import type { Question } from "../../src/shared/types.ts";
import { DEFAULT_LIMITS, LONG_ANSWER_LIMITS, MAX_BODY_BYTES, probe, type ProbeInput, UA } from "../../src/worker/probe.ts";

const KEY = "sk-test-12345678";

function question(id: string): Question {
	const q = getQuestion(id);
	if (!q) throw new Error(`missing question ${id}`);
	return q;
}

function customQuestion(prompt: string, scorer: Question["scorer"]): Question {
	return { id: "custom", version: 0, status: "active", title: "", measures: "", kind: "knowledge", scorer, expectedLabel: "", calibratedModels: [], failureHint: "", prompt };
}

type Chunk = { at: number; text: string };
type Reply = { status: number; headers?: Record<string, string>; ttfb: number; chunks: Chunk[] };

// The clock only moves when the fake server delivers something, so every timing is a literal.
function fakeUpstream(reply: Reply) {
	let clock = 0;
	const requests: { url: string; init: RequestInit }[] = [];
	const state = { cancelled: false };
	const encoder = new TextEncoder();
	const queue = [...reply.chunks];
	const fetch = async (url: string, init: RequestInit) => {
		requests.push({ url, init });
		clock = reply.ttfb;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = queue.shift();
				if (!next) return controller.close();
				clock = next.at;
				controller.enqueue(encoder.encode(next.text));
			},
			cancel() {
				state.cancelled = true;
			},
		}, { highWaterMark: 0 });
		return new Response(body, { status: reply.status, headers: reply.headers });
	};
	return { deps: { fetch, now: () => clock }, requests, state };
}

function input(overrides: Partial<ProbeInput>): ProbeInput {
	return {
		origin: "https://api.example.com",
		key: KEY,
		protocol: "responses",
		model: "gpt-6-astra",
		question: question("thibault"),
		effort: null,
		limits: DEFAULT_LIMITS,
		...overrides,
	};
}

const sse = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;

describe("probe", () => {
	it("parses a streamed responses call", async () => {
		const id = "resp_68ab12cd34ef";
		const { deps, requests } = fakeUpstream({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			ttfb: 100,
			chunks: [
				{ at: 150, text: `event: response.created\n${sse({ type: "response.created", response: { id, error: null } })}` },
				{ at: 250, text: sse({ type: "response.output_text.delta", delta: "Yes, I know" }) },
				{ at: 300, text: sse({ type: "response.output_text.delta", delta: " him." }) },
				{
					at: 400,
					text: sse({
						type: "response.completed",
						response: {
							id,
							usage: {
								input_tokens: 31,
								input_tokens_details: { cached_tokens: 0 },
								output_tokens: 20,
								output_tokens_details: { reasoning_tokens: 12 },
							},
						},
					}),
				},
			],
		});
		const result = await probe(input({}), deps);
		expect(result.response).toEqual({
			ok: true,
			questionVersion: 1,
			correct: true,
			note: "YES",
			reasoningTokens: 12,
			outputTokens: 20,
			idShape: "hex",
			answer: "Yes, I know him.",
			streamed: true,
			ttfbMs: 100,
			ttftMs: 250,
			totalMs: 400,
			promptTokens: 31,
			cachedTokens: 0,
		});
		expect(result.capture.rawEvents?.map((e) => e.t)).toEqual([150, 250, 300, 400]);
		expect(result.capture.truncated).toBe(false);
		expect(requests[0].url).toBe("https://api.example.com/v1/responses");
		expect(requests[0].init.redirect).toBe("manual");
		expect(requests[0].init.headers).toEqual({
			"User-Agent": UA,
			Authorization: `Bearer ${KEY}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		});
		expect(JSON.parse(String(requests[0].init.body))).toEqual({
			model: "gpt-6-astra",
			input: question("thibault").prompt,
			stream: true,
		});
	});

	it("appends the endpoint path to a prefixed origin", async () => {
		const { deps, requests } = fakeUpstream({ status: 200, ttfb: 10, chunks: [{ at: 20, text: sse({ type: "response.completed", response: { id: "resp_68ab12cd34ef" } }) }] });
		await probe(input({ origin: "https://openrouter.ai/api", protocol: "chat" }), deps);
		expect(requests[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
	});

	it("parses a streamed chat call with an event split across chunks", async () => {
		const usageChunk = sse({
			id: "chatcmpl-abc",
			choices: [],
			usage: {
				prompt_tokens: 128,
				prompt_tokens_details: { cached_tokens: 64 },
				completion_tokens: 320,
				completion_tokens_details: { reasoning_tokens: 300 },
			},
		});
		const { deps, requests } = fakeUpstream({
			status: 200,
			ttfb: 80,
			chunks: [
				{ at: 90, text: sse({ id: "chatcmpl-abc", choices: [{ delta: { role: "assistant", content: "" } }], usage: null }) },
				{ at: 200, text: sse({ id: "chatcmpl-abc", choices: [{ delta: { content: "至少 21 颗:9 颗圆形," } }], usage: null }) },
				{ at: 260, text: sse({ id: "chatcmpl-abc", choices: [{ delta: { content: "12 颗五角星" } }], usage: null }) },
				{ at: 300, text: usageChunk.slice(0, 20) },
				{ at: 320, text: `${usageChunk.slice(20)}data: [DONE]\n\n` },
			],
		});
		const result = await probe(input({ protocol: "chat", question: question("candy"), effort: "low" }), deps);
		expect(result.response).toEqual({
			ok: true,
			questionVersion: 1,
			correct: true,
			note: "ok",
			reasoningTokens: 300,
			outputTokens: 320,
			idShape: "other",
			answer: "至少 21 颗:9 颗圆形,12 颗五角星",
			streamed: true,
			ttfbMs: 80,
			ttftMs: 200,
			totalMs: 320,
			promptTokens: 128,
			cachedTokens: 64,
		});
		expect(requests[0].url).toBe("https://api.example.com/v1/chat/completions");
		expect(JSON.parse(String(requests[0].init.body))).toEqual({
			model: "gpt-6-astra",
			messages: [{ role: "user", content: question("candy").prompt }],
			stream: true,
			stream_options: { include_usage: true },
			reasoning_effort: "low",
		});
	});

	it("parses a streamed anthropic call, sending the key as x-api-key and counting cached input as prompt", async () => {
		const event = (type: string, fields: object = {}) => `event: ${type}\n${sse({ type, ...fields })}`;
		const { deps, requests } = fakeUpstream({
			status: 200,
			ttfb: 70,
			chunks: [
				{
					at: 90,
					text: event("message_start", {
						message: { id: "msg_01AbC", usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 11, output_tokens: 1 } },
					}),
				},
				{ at: 120, text: event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "他是谁" } }) },
				{ at: 200, text: event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Yes, I know" } }) },
				{ at: 230, text: event("content_block_delta", { index: 1, delta: { type: "text_delta", text: " him." } }) },
				{ at: 260, text: event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }) },
				{ at: 270, text: event("message_stop") },
			],
		});
		const result = await probe(input({ protocol: "anthropic", model: "claude-opus-5-5", effort: "high" }), deps);
		expect(result.response).toEqual({
			ok: true,
			questionVersion: 1,
			correct: true,
			note: "YES",
			reasoningTokens: null,
			outputTokens: 40,
			idShape: "other",
			answer: "Yes, I know him.",
			streamed: true,
			ttfbMs: 70,
			ttftMs: 200,
			totalMs: 270,
			promptTokens: 31,
			cachedTokens: 11,
		});
		expect(requests[0].url).toBe("https://api.example.com/v1/messages");
		expect(requests[0].init.headers).toEqual({
			"User-Agent": UA,
			"x-api-key": KEY,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		});
		expect(JSON.parse(String(requests[0].init.body))).toEqual({
			model: "claude-opus-5-5",
			max_tokens: 32000,
			messages: [{ role: "user", content: question("thibault").prompt }],
			stream: true,
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		});
	});

	it("reads a whole anthropic message when the relay ignores stream", async () => {
		const body = { id: "msg_01AbC", type: "message", content: [{ type: "thinking", thinking: "嗯" }, { type: "text", text: "No, I don't." }], usage: { input_tokens: 31 } };
		const { deps } = fakeUpstream({ status: 200, ttfb: 50, chunks: [{ at: 60, text: JSON.stringify(body) }] });
		const result = await probe(input({ protocol: "anthropic" }), deps);
		expect(result.response).toMatchObject({ ok: true, correct: false, answer: "No, I don't.", streamed: false, promptTokens: 31, cachedTokens: null });
	});

	it("falls back to a whole JSON body with raw control characters", async () => {
		const body =
			'{"id":"resp_ft_123","error":null,"output":[{"type":"message","content":[{"type":"output_text","text":"No,\nI don\'t"}]}],' +
			'"usage":{"input_tokens":31,"output_tokens_details":{"reasoning_tokens":2}}}';
		const { deps } = fakeUpstream({
			status: 200,
			headers: { "content-type": "application/json" },
			ttfb: 500,
			chunks: [{ at: 510, text: body }],
		});
		const result = await probe(input({}), deps);
		expect(result.response).toEqual({
			ok: true,
			questionVersion: 1,
			correct: false,
			note: "NO",
			reasoningTokens: 2,
			outputTokens: null,
			idShape: "ft",
			answer: "No,\nI don't",
			streamed: false,
			ttfbMs: 500,
			ttftMs: null,
			totalMs: 510,
			promptTokens: 31,
			cachedTokens: null,
		});
		expect(result.capture.rawBody).toBe(body);
	});

	it("scores a custom question's prompt through the same builder and scorer table", async () => {
		const prompt = "用一句话回答:本站的名字是什么?";
		const { deps, requests } = fakeUpstream({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			ttfb: 60,
			chunks: [
				{ at: 70, text: sse({ type: "response.created", response: { id: "resp_68ab12cd34ef" } }) },
				{ at: 120, text: sse({ type: "response.output_text.delta", delta: "本站的名字是 ziikoo。" }) },
			],
		});
		const result = await probe(input({ question: customQuestion(prompt, { type: "contains", expected: "ziikoo" }) }), deps);
		expect(result.response).toMatchObject({ ok: true, questionVersion: 0, correct: true, note: "ok", answer: "本站的名字是 ziikoo。" });
		expect(result.response).not.toHaveProperty("artifact");
		expect(JSON.parse(String(requests[0].init.body))).toEqual({ model: "gpt-6-astra", input: prompt, stream: true });
	});

	it("returns the full answer as the artifact of an svg_animation question", async () => {
		const html = `<!doctype html><html><body><svg><circle r="${"9".repeat(100)}"><animate attributeName="r"/></circle></svg></body></html>`;
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 60,
			chunks: [{ at: 80, text: sse({ type: "response.output_text.delta", delta: `  ${html}\n` }) }],
		});
		const result = await probe(input({ question: question("pelican-svg") }), deps);
		expect(result.response).toMatchObject({ ok: true, correct: true, artifact: { html, ending: "closed" } });
		expect(result.capture).not.toHaveProperty("artifact");
	});

	it("cuts the page out of a fenced answer", async () => {
		const answer = "下面是页面:\n```html\n<!DOCTYPE html>\n<html><body><canvas></canvas></body></html>\n```\n保存后用浏览器打开。";
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 60,
			chunks: [{ at: 80, text: sse({ type: "response.output_text.delta", delta: answer }) }],
		});
		const result = await probe(input({ question: question("pelican-svg") }), deps);
		expect(result.response).toMatchObject({
			ok: true,
			artifact: { html: "<!DOCTYPE html>\n<html><body><canvas></canvas></body></html>", ending: "closed" },
		});
	});

	it("plays the answer's last page and marks it unclosed when the answer stops before </html>", async () => {
		const answer = "结构:\n```html\n<!DOCTYPE html><html><body>...</body></html>\n```\n现在写代码。\n```html\n<html><body><svg><circle r=\"9\"/>";
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 60,
			chunks: [{ at: 80, text: sse({ type: "response.output_text.delta", delta: answer }) }],
		});
		const result = await probe(input({ question: question("pelican-svg") }), deps);
		expect(result.response).toMatchObject({ ok: true, artifact: { html: '<html><body><svg><circle r="9"/>', ending: "unclosed" } });
	});

	it("plays a bare svg answer whole", async () => {
		const answer = "<style>svg{width:100%}</style>\n<svg><animate/></svg>";
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 60,
			chunks: [{ at: 80, text: sse({ type: "response.output_text.delta", delta: `\n${answer}\n` }) }],
		});
		const result = await probe(input({ question: question("pelican-svg") }), deps);
		expect(result.response).toMatchObject({ ok: true, artifact: { html: answer, ending: "closed" } });
	});

	it("returns no artifact when the answer holds no page", async () => {
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 60,
			chunks: [{ at: 80, text: sse({ type: "response.output_text.delta", delta: "2" }) }],
		});
		const result = await probe(input({ question: question("pelican-svg") }), deps);
		expect(result.response).toMatchObject({ ok: true, answer: "2" });
		expect(result.response).not.toHaveProperty("artifact");
	});

	it("marks the artifact's ending truncated when the HTML answer runs past the body cap", async () => {
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 10,
			chunks: [
				{ at: 20, text: sse({ type: "response.output_text.delta", delta: "<!doctype html><html><body><svg>" }) },
				{ at: 30, text: sse({ type: "response.output_text.delta", delta: "<g/>".repeat(1024) }) },
			],
		});
		const result = await probe(input({ question: question("pelican-svg"), limits: { ...LONG_ANSWER_LIMITS, maxBodyBytes: 1024 } }), deps);
		expect(result.response).toMatchObject({ ok: true, artifact: { html: "<!doctype html><html><body><svg>", ending: "truncated" } });
	});

	it("scores a custom yes_no question", async () => {
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 60,
			chunks: [{ at: 80, text: sse({ type: "response.output_text.delta", delta: "Yes." }) }],
		});
		const result = await probe(input({ question: customQuestion("你认识他吗", { type: "yes_no", expected: "YES" }) }), deps);
		expect(result.response).toMatchObject({ ok: true, questionVersion: 0, correct: true, note: "YES" });
	});

	it("maps 401 and redacts a key the site echoes back", async () => {
		const { deps } = fakeUpstream({
			status: 401,
			headers: { "content-type": "application/json", "x-echo": `Bearer ${KEY}`, "set-cookie": "sid=1" },
			ttfb: 40,
			chunks: [{ at: 45, text: `{"error":{"message":"Incorrect API key provided: ${KEY}"}}` }],
		});
		const result = await probe(input({}), deps);
		expect(result.response).toEqual({ ok: false, reason: "unauthorized", httpStatus: 401 });
		expect(result.capture.rawBody).toBe('{"error":{"message":"Incorrect API key provided: [REDACTED]"}}');
		expect(result.capture.rawHeaders).toEqual({ "content-type": "application/json", "x-echo": "[REDACTED]" });
		expect(JSON.stringify(result)).not.toContain(KEY);
	});

	it("redacts a key the site echoes across several stream deltas", async () => {
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 10,
			chunks: ["Invalid key ", "sk", "-test", "-1234", "5678", " rejected"].map((delta, i) => ({
				at: 20 + i,
				text: sse({ type: "response.output_text.delta", delta }),
			})),
		});
		const result = await probe(input({}), deps);
		expect(result.capture.answer).toBe("Invalid key [REDACTED] rejected");
		expect(result.capture.rawEvents).toBeNull();
		expect(result.capture.truncated).toBe(true);
		expect(JSON.stringify(result)).not.toContain(KEY);
	});

	it("redacts a key the site echoes with unicode escapes in a whole JSON body", async () => {
		const escaped = [...KEY].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 10,
			chunks: [{ at: 20, text: `{"choices":[{"message":{"content":"${escaped}"}}]}` }],
		});
		const result = await probe(input({ protocol: "chat" }), deps);
		expect(result.capture.answer).toBe("[REDACTED]");
		expect(result.capture.rawBody).toBeNull();
		expect(result.capture.truncated).toBe(true);
		expect(JSON.stringify(result)).not.toContain(KEY);
	});

	it("measures TTFT as the arrival of the first delta even when it shares a chunk with the final event", async () => {
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 100,
			chunks: [
				{ at: 150, text: sse({ type: "response.created", response: { id: "resp_68ab12cd34ef" } }) },
				{
					at: 900,
					text:
						sse({ type: "response.output_text.delta", delta: "Yes, I know him." }) +
						sse({ type: "response.completed", response: { id: "resp_68ab12cd34ef" } }),
				},
			],
		});
		const result = await probe(input({}), deps);
		expect(result.response).toMatchObject({ ok: true, correct: true, streamed: true, ttftMs: 900 });
		expect(result.capture.rawEvents?.map((e) => e.t)).toEqual([150, 900, 900]);
	});

	it("stops reading past the body cap and marks the capture truncated", async () => {
		const filler = sse({ type: "response.output_text.delta", delta: "a".repeat(100 * 1024) });
		const { deps, state } = fakeUpstream({
			status: 200,
			ttfb: 10,
			chunks: [1, 2, 3, 4].map((i) => ({ at: 10 + i, text: filler })),
		});
		const result = await probe(input({}), deps);
		const storedBytes = (result.capture.rawEvents ?? []).reduce((n, e) => n + new TextEncoder().encode(e.data).byteLength, 0);
		expect(result.capture.truncated).toBe(true);
		expect(state.cancelled).toBe(true);
		expect(storedBytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
		expect(result.capture.rawEvents).toHaveLength(3);
	});

	it("reports answer characters once the site answers, at most once per half second", async () => {
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 100,
			chunks: [
				{ at: 200, text: sse({ type: "response.created", response: { id: "resp_1" } }) },
				{ at: 300, text: `data: {"type":"response.output_text.delta","del` },
				{ at: 400, text: `ta":"<html>"}\r\n\r\n` },
				{ at: 700, text: sse({ type: "response.output_text.delta", delta: "<body>" }) },
				{ at: 800, text: sse({ type: "response.output_text.delta", delta: "</body></html>" }) },
			],
		});
		const reports: number[] = [];
		await probe(input({ question: question("pelican-svg"), onProgress: (chars) => reports.push(chars) }), deps);
		expect(reports).toEqual([0, 12]);
	});

	it("reads a 3MB HTML answer, past the default cap and the former 2MB one, under the long-answer limits", async () => {
		const body = `<svg>${"<g/>".repeat(256 * 1024)}<animate/></svg>`;
		const parts = ["<!doctype html><html><body>", body, body, body, "</body></html>"];
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 10,
			chunks: parts.map((delta, i) => ({ at: 20 + i, text: sse({ type: "response.output_text.delta", delta }) })),
		});
		const result = await probe(input({ question: question("pelican-svg"), limits: LONG_ANSWER_LIMITS }), deps);
		expect(result.capture.truncated).toBe(false);
		expect(result.response).toMatchObject({ ok: true, correct: true, note: "ok" });
	});
});

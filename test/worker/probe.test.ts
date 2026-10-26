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
							usage: { input_tokens: 31, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 12 } },
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
		expect(result.response).toMatchObject({ ok: true, correct: true, artifact: html });
		expect(result.capture).not.toHaveProperty("artifact");
	});

	it("returns a custom HTML question's full answer as the artifact without scoring it", async () => {
		const html = "<!doctype html><html><body><canvas></canvas></body></html>";
		const { deps } = fakeUpstream({
			status: 200,
			ttfb: 60,
			chunks: [{ at: 80, text: sse({ type: "response.output_text.delta", delta: html }) }],
		});
		const result = await probe(input({ question: { ...customQuestion("写一个 HTML 时钟", undefined), html: true } }), deps);
		expect(result.response).toMatchObject({ ok: true, correct: null, note: "unscored", artifact: html });
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

	it("reads an HTML answer past the default cap under the long-answer limits", async () => {
		const body = `<svg>${"<g/>".repeat(25 * 1024)}<animate/></svg>`;
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

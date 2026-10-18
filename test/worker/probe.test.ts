import { describe, expect, it } from "vitest";
import { getQuestion } from "../../questions/index.ts";
import type { Question } from "../../src/shared/types.ts";
import { MAX_BODY_BYTES, probe, type ProbeInput, UA } from "../../src/worker/probe.ts";

const KEY = "sk-test-12345678";

function question(id: string): Question {
	const q = getQuestion(id);
	if (!q) throw new Error(`missing question ${id}`);
	return q;
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
});

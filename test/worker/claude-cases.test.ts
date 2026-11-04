import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CASES, type ClaudeCaseId } from "../../src/shared/claude-cases.ts";
import { ClaudeCaseRateLimited, runClaudeCase } from "../../src/worker/claude-cases.ts";
import { parseClaudeCaseRequest } from "../../src/worker/request.ts";
import cacheUsageRecording from "./testdata/claude/cache-usage.json";
import cacheWarmRecording from "./testdata/claude/cache-warm.json";
import countTokensRecording from "./testdata/claude/count-tokens.json";
import errorMissingMaxTokensRecording from "./testdata/claude/error-missing-max-tokens.json";
import messageRecording from "./testdata/claude/message.json";
import nativeCountTokensRecording from "./testdata/claude/native-count-tokens.json";
import nativeErrorMissingMaxTokensRecording from "./testdata/claude/native-error-missing-max-tokens.json";
import streamRecording from "./testdata/claude/stream.json";
import thinkingRecording from "./testdata/claude/thinking.json";
import toolUseRecording from "./testdata/claude/tool-use.json";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { default: worker } = await import("../../src/worker/index.ts");
const KEY = "sk-test-12345678";
const MODEL = "claude-sonnet-4-6";
const input = (id: ClaudeCaseId, model = MODEL) => ({ origin: "https://api.example.com", host: "api.example.com", key: KEY, model, case: id });
const text = (answer = "OK", extra: object = {}) => ({ type: "message", id: "msg_01_private", content: [{ type: "text", text: answer }], usage: { input_tokens: 12, output_tokens: 1 }, ...extra });
const reply = (body: unknown, status = 200, requestId = "req_safe") => new Response(JSON.stringify(body), { status, headers: { "request-id": requestId } });
const tool = { type: "tool_use", id: "toolu_123", name: "get_weather", input: { location: "Paris" } };
const thinking = { type: "thinking", thinking: "Let me calculate.", signature: "signed_abc" };
const event = (data: object) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const stream = () => new Response(event({ type: "message_start", message: { id: "msg_vrtx_private" } }) + event({ type: "content_block_delta", delta: { type: "text_delta", text: "OK" } }) + event({ type: "message_stop" }), { headers: { "request-id": "req_stream" } });

function fake(responses: (() => Response)[]) {
	const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
	let tick = 0;
	const limit = vi.fn(async () => ({ success: true }));
	const fetch = vi.fn(async (url: string, init: RequestInit) => {
		expect(limit).toHaveBeenCalledTimes(requests.length + 1);
		requests.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : {} });
		const next = responses.shift();
		if (!next) throw new Error("Unexpected upstream request");
		return next();
	});
	return { requests, deps: { fetch, limit, now: () => ++tick } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Claude case executor", () => {
	it("runs every Claude case against a fake site", async () => {
		const scenarios: Record<ClaudeCaseId, (() => Response)[]> = {
			C1: [() => reply(text())], C2: [stream, stream, stream], C3: [() => reply(text("red"))],
			C4: [() => reply(text('{"name":"Alice","age":30}'))], C5: [() => reply(text())],
			C6: [() => reply(text("", { content: [tool] })), () => reply(text("Sunny"))],
			C7: [() => reply(text())], C8: [() => reply(text("4", { content: [thinking, { type: "text", text: "4" }] })), () => reply(text()), () => reply({ error: { message: "Invalid signature" } }, 400)],
			C9: [() => reply(text("OK", { usage: { input_tokens: 10, cache_creation_input_tokens: 9990, cache_read_input_tokens: 20000 } })), ...Array.from({ length: 4 }, () => () => reply(text("OK", { usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 29500 } })))],
			C10: [() => reply(text()), () => reply({ input_tokens: 12 })], P1: [() => reply({ data: [{ id: MODEL }] })],
			P2: [() => reply({ error: { message: "max_tokens is required" } }, 400)], P3: [],
		};
		for (const { id } of CLAUDE_CASES) {
			const expectedCalls = scenarios[id].length;
			const { deps, requests } = fake(scenarios[id]);
			const result = await runClaudeCase(input(id), deps);
			expect(result.verdict, id).toBe(id === "P3" ? "untested" : "pass");
			expect(result.calls, id).toHaveLength(expectedCalls);
			expect(deps.limit, id).toHaveBeenCalledTimes(expectedCalls);
			for (const call of result.calls) {
				expect(call.ms).toBeGreaterThanOrEqual(0);
				expect(call.requestId).toMatch(/^req_/);
			}
			for (const request of requests) {
				expect(["https://api.example.com/v1/messages", "https://api.example.com/v1/messages/count_tokens", "https://api.example.com/v1/models"]).toContain(request.url);
				expect(request.init.redirect).toBe("manual");
				expect(request.init.signal).toBeInstanceOf(AbortSignal);
			}
			if (id === "C1") expect(requests[0].body).toEqual({ model: MODEL, max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly OK" }] });
			if (id === "C2") expect(result.note).toMatch(/首字.*\d/);
			if (id === "C3") {
				const messages = requests[0].body.messages as { content: { source: { type: string; media_type: string; data: string } }[] }[];
				const image = messages[0].content[0].source;
				expect(image).toMatchObject({ type: "base64", media_type: "image/png" });
				const png = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
				const view = new DataView(png.buffer);
				expect(view.getUint32(16)).toBe(8);
				expect(view.getUint32(20)).toBe(8);
				const chunks: Uint8Array[] = [];
				for (let offset = 8; offset < png.length;) {
					const size = view.getUint32(offset);
					if (new TextDecoder().decode(png.subarray(offset + 4, offset + 8)) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + size));
					offset += size + 12;
				}
				const compressed = new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
				const pixels = await new Response(new Response(compressed).body!.pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
				expect([...new Uint8Array(pixels)]).toEqual(Array.from({ length: 8 }, () => [0, ...Array.from({ length: 8 }, () => [255, 0, 0]).flat()]).flat());
			}
			if (id === "C4") expect(requests[0].body.output_config).toMatchObject({ format: { type: "json_schema", schema: { type: "object", required: ["name", "age"], additionalProperties: false } } });
			if (id === "C5") expect(requests[0].body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
			if (id === "C6") expect(requests[1].body.messages).toEqual([requests[0].body.messages && (requests[0].body.messages as object[])[0], { role: "assistant", content: [tool] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "Sunny, 20 degrees Celsius." }] }]);
			if (id === "C7") expect(requests[0].body.thinking).toEqual({ type: "disabled" });
			if (id === "C8") {
				expect(requests[0].body.thinking).toEqual({ type: "adaptive" });
				const replay = (requests[1].body.messages as { content: unknown }[])[1].content as { signature: string }[];
				const altered = (requests[2].body.messages as { content: unknown }[])[1].content as { signature: string }[];
				expect(replay[0]).toEqual(thinking);
				expect([...altered[0].signature].filter((char, index) => char !== replay[0].signature[index])).toHaveLength(1);
			}
			if (id === "C9") {
				expect(new Set(requests.map((request) => JSON.stringify(request.body))).size).toBe(1);
				expect(requests[0].body.cache_control).toEqual({ type: "ephemeral" });
				expect(result.note).toContain("cache_read");
				expect(result.note).toContain("95.0%");
			}
			if (id === "C10") {
				expect(requests.map((request) => request.url)).toEqual(["https://api.example.com/v1/messages", "https://api.example.com/v1/messages/count_tokens"]);
				expect(requests[0].body).toEqual({ model: MODEL, max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly OK" }] });
				expect(requests.at(-1)!.body).not.toHaveProperty("max_tokens");
			}
			if (id === "P2") expect(requests[0].body).not.toHaveProperty("max_tokens");
			if (id === "P3") expect(result.note).toBe("批量接口会创建异步任务并计费，本站不测");
		}
	});

	it.each(["claude-opus-5-5", "claude-sonnet-5-5-20261001"])("expects 400 for C5 and C7 on %s", async (model) => {
		for (const id of ["C5", "C7"] as const) {
			expect((await runClaudeCase(input(id, model), fake([() => reply({}, 400)]).deps)).verdict).toBe("pass");
			expect((await runClaudeCase(input(id, model), fake([() => reply(text())]).deps)).verdict).toBe("fail");
		}
	});

	it.each([["msg_bdrk_hidden", "bedrock"], ["msg_vrtx_hidden", "vertex"], ["msg_01_hidden", "anthropic"], ["private", "other"]])("returns only the source for %s and redacts before truncation", async (id, source) => {
		const { deps } = fake([() => reply(text(`Bearer ${KEY}${"红".repeat(90)}`, { id }), 200, `req_${KEY}`)]);
		const result = await runClaudeCase(input("C1"), deps);
		expect(result.source).toBe(source);
		expect([...result.preview!]).toHaveLength(70);
		expect(result.preview).toMatch(/^\[REDACTED\]/);
		expect(result.calls[0].requestId).toBeNull();
		expect(JSON.stringify(result)).not.toContain(KEY);
		expect(JSON.stringify(result)).not.toContain(id);
	});

	it.each(["req_bad!", "r".repeat(129), ""])("drops invalid request ids %s", async (requestId) => {
		expect((await runClaudeCase(input("C1"), fake([() => reply(text(), 200, requestId)]).deps)).calls[0].requestId).toBeNull();
	});

	it("rejects malformed, incomplete, out-of-order, and errored SSE streams", async () => {
		for (const body of [event({ type: "message_start" }) + event({ type: "message_stop" }), event({ type: "message_stop" }) + event({ type: "content_block_delta", delta: { type: "text_delta", text: "OK" } }) + event({ type: "message_start" }), event({ type: "message_start" }) + event({ type: "content_block_delta", delta: { type: "text_delta", text: "OK" } }) + event({ type: "error" }) + event({ type: "message_stop" }), "data: {broken}\n\n"]) {
			const result = await runClaudeCase(input("C2"), fake([() => new Response(body), stream, stream]).deps);
			expect(result.verdict).toBe("fail");
			expect(result.calls).toHaveLength(3);
		}
	});

	it("joins split UTF-8 and SSE deltas before redacting", async () => {
		const encoded = new TextEncoder().encode(event({ type: "message_start" }) + event({ type: "content_block_delta", delta: { type: "text_delta", text: KEY.slice(0, 9) } }) + event({ type: "content_block_delta", delta: { type: "text_delta", text: KEY.slice(9) + "红" } }) + event({ type: "message_stop" }));
		const response = () => new Response(new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
		const result = await runClaudeCase(input("C2"), fake([response, response, response]).deps);
		expect(result.verdict).toBe("pass");
		expect(result.preview).toBe("[REDACTED]红");
	});

	it("fails a fake cache hit on a site-added prefix and refreshes the random prefix between runs", async () => {
		const responses = () => Array.from({ length: 5 }, () => () => reply(text("OK", { usage: { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 50000 } })));
		const first = fake(responses());
		const second = fake(responses());
		expect((await runClaudeCase(input("C9"), first.deps)).verdict).toBe("fail");
		await runClaudeCase(input("C9"), second.deps);
		expect(first.requests[0].body.messages).not.toEqual(second.requests[0].body.messages);
	});

	it("marks the absent token endpoint as a gap and identifies the Mantle limitation", async () => {
		expect(await runClaudeCase(input("C10"), fake([() => reply(text()), () => reply({}, 404)]).deps)).toMatchObject({ verdict: "gap", note: "中转未暴露同路径" });
		expect(await runClaudeCase(input("C10"), fake([() => reply(text("OK", { id: "msg_bdrk_hidden" })), () => reply({ input_tokens: 3 })]).deps)).toMatchObject({ verdict: "pass", source: "bedrock", note: expect.stringContaining("无法测 Mantle") });
		expect(await runClaudeCase(input("C10"), fake([() => reply(text("OK", { id: "msg_bdrk_hidden" })), () => reply({}, 404)]).deps)).toMatchObject({ verdict: "gap", source: "bedrock", note: "中转未暴露同路径；无法测 Mantle" });
		const anthropic = await runClaudeCase(input("C10"), fake([() => reply(text("OK", { id: "msg_01_x" })), () => reply({ input_tokens: 3 })]).deps);
		expect(anthropic).toMatchObject({ verdict: "pass", source: "anthropic" });
		expect(anthropic.note).not.toContain("无法测 Mantle");
		for (const input_tokens of [0, -1, "12", null]) {
			expect(await runClaudeCase(input("C10"), fake([() => reply(text("OK", { id: "msg_bdrk_hidden" })), () => reply({ input_tokens })]).deps)).toMatchObject({ verdict: "fail", source: "bedrock", note: expect.stringContaining("无法测 Mantle") });
		}
	});

	it("uses only the token endpoint to decide C10 after a failed message call", async () => {
		for (const message of [() => reply({}, 503), () => { throw new Error(KEY); }]) {
			const { deps, requests } = fake([message, () => reply({ input_tokens: 3 })]);
			const result = await runClaudeCase(input("C10"), deps);
			expect(result).toMatchObject({ verdict: "pass", source: null });
			expect(result.calls).toHaveLength(2);
			expect(requests.map((request) => request.url)).toEqual(["https://api.example.com/v1/messages", "https://api.example.com/v1/messages/count_tokens"]);
		}
	});

	it("requires the target model and a structured error request id", async () => {
		expect((await runClaudeCase(input("P1"), fake([() => reply({ data: [{ id: "other" }] })]).deps)).verdict).toBe("fail");
		expect((await runClaudeCase(input("P2"), fake([() => reply({ request_id: "body-id" }, 422, "")]).deps)).verdict).toBe("pass");
		expect((await runClaudeCase(input("P2"), fake([() => reply({ error: "mentions request_id" }, 400, "")]).deps)).verdict).toBe("fail");
	});

	it("checks status and request headers even when an expected error body is not JSON", async () => {
		for (const id of ["C5", "C7", "P2"] as const) {
			const result = await runClaudeCase(input(id, "claude-opus-5-5"), fake([() => new Response("Bad request", { status: 400, headers: { "request-id": "req_plain" } })]).deps);
			expect(result.verdict, id).toBe("pass");
		}
		expect((await runClaudeCase(input("P1"), fake([() => new Response(null, { status: 204 })]).deps)).verdict).toBe("fail");
	});

	it("records network failures without exposing errors and stops before a denied host call", async () => {
		const network = fake([() => { throw new Error(KEY); }]);
		expect(await runClaudeCase(input("C1"), network.deps)).toMatchObject({ verdict: "fail", calls: [{ status: null, requestId: null, ms: expect.any(Number) }] });
		const denied = fake([stream]);
		denied.deps.limit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
		await expect(runClaudeCase(input("C2"), denied.deps)).rejects.toBeInstanceOf(ClaudeCaseRateLimited);
		expect(denied.deps.fetch).toHaveBeenCalledTimes(1);
	});

	it("does not use error bodies as successful case responses or follow redirects", async () => {
		for (const id of ["C1", "C3", "C4", "C6", "C8", "C10"] as const) {
			const responses = [() => reply(text('red {"name":"Alice","age":30}', { input_tokens: 12, content: [tool, thinking] }), 302)];
			if (id === "C10") responses.unshift(() => reply(text()));
			const result = await runClaudeCase(input(id), fake(responses).deps);
			expect(result.verdict).toBe("fail");
			if (id === "C10") expect(result.calls.map((call) => call.status)).toEqual([200, 302]);
		}
		expect((await runClaudeCase(input("C4"), fake([() => reply(text(' {"name":"Alice","age":30}'))]).deps)).verdict).toBe("fail");
		expect((await runClaudeCase(input("C8"), fake([() => reply(text())]).deps)).calls).toHaveLength(1);
	});
});

describe("Claude case executor on recorded responses", () => {
	type Recording = { status: number; headers: { "request-id": string | null }; body: unknown };
	const recordings: Record<string, Recording> = { "cache-usage": cacheUsageRecording, "cache-warm": cacheWarmRecording, "count-tokens": countTokensRecording, "error-missing-max-tokens": errorMissingMaxTokensRecording, "message": messageRecording, "native-count-tokens": nativeCountTokensRecording, "native-error-missing-max-tokens": nativeErrorMissingMaxTokensRecording, "stream": streamRecording, "thinking": thinkingRecording, "tool-use": toolUseRecording };
	const recorded = (name: string): Recording => recordings[name];
	const replay = (name: string) => () => {
		const { status, headers, body } = recorded(name);
		const requestId = headers["request-id"];
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: requestId === null ? {} : { "request-id": requestId } });
	};

	it("parses recorded message, stream, cache, and count_tokens responses", async () => {
		const cases: [ClaudeCaseId, string[], object][] = [
			["C1", ["message"], { verdict: "pass", source: "bedrock", preview: "OK" }],
			["C2", ["stream", "stream", "stream"], { verdict: "pass", source: "bedrock", preview: "OK" }],
			["C9", ["cache-warm", "cache-usage", "cache-usage", "cache-usage", "cache-usage"], { verdict: "pass", note: "freshHit：99.9%、99.9%、99.9%、99.9%；cache_read：0、5531、5531、5531、5531" }],
			["C10", ["message", "count-tokens"], { verdict: "gap", source: "bedrock", note: "中转未暴露同路径；无法测 Mantle" }],
			["P2", ["error-missing-max-tokens"], { verdict: "fail" }],
		];
		for (const [id, names, expected] of cases) {
			const result = await runClaudeCase(input(id), fake(names.map(replay)).deps);
			expect(result, id).toMatchObject(expected);
			expect(result.calls.map((call) => [call.status, call.requestId]), id).toEqual(names.map((name) => [recorded(name).status, null]));
			expect(JSON.stringify(result), id).not.toContain("msg_bdrk_");
		}
	});

	it("parses recorded native count_tokens success and request ids", async () => {
		const tokens = await runClaudeCase(input("C10"), fake([replay("message"), replay("native-count-tokens")]).deps);
		expect(tokens).toMatchObject({ verdict: "pass", source: "bedrock", note: "响应满足用例要求；无法测 Mantle" });
		expect(tokens.calls.map((call) => [call.status, call.requestId])).toEqual([[200, null], [200, "req_011CgiAfaRnD4Sf2GgthJaxW"]]);

		const error = await runClaudeCase(input("P2"), fake([replay("native-error-missing-max-tokens")]).deps);
		expect(error).toMatchObject({ verdict: "pass", calls: [{ status: 400, requestId: "req_011CgiAfeFxNifG9ZZn4qku7" }] });
		const { status, body } = recorded("native-error-missing-max-tokens");
		const bodyOnly = await runClaudeCase(input("P2"), fake([() => new Response(JSON.stringify(body), { status })]).deps);
		expect(bodyOnly).toMatchObject({ verdict: "pass", calls: [{ status: 400, requestId: null }] });
	});

	it("sends the long-prefix prompt with a single measurement seed", async () => {
		const cache = fake(["cache-warm", "cache-usage", "cache-usage", "cache-usage", "cache-usage"].map(replay));
		await runClaudeCase(input("C9"), cache.deps);
		const prompt = String((cache.requests[0].body.messages as { content: unknown }[])[0].content);
		expect(prompt).toMatch(/^Measurement \d+\.\n\n/);
		expect(prompt.match(/Measurement /g)).toHaveLength(1);
	});

	it("returns the recorded tool_use and thinking blocks unchanged", async () => {
		const tools = fake([replay("tool-use"), replay("message")]);
		expect((await runClaudeCase(input("C6"), tools.deps)).verdict).toBe("pass");
		const toolMessages = tools.requests[1].body.messages as { content: unknown }[];
		expect(toolMessages[1].content).toEqual((recorded("tool-use").body as { content: unknown }).content);
		expect(toolMessages[2].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_bdrk_01MR5UWa8dZHATCdSYM9z5AB", content: "Sunny, 20 degrees Celsius." }]);

		const thinking = fake([replay("thinking"), replay("message"), replay("count-tokens")]);
		expect((await runClaudeCase(input("C8"), thinking.deps)).verdict).toBe("pass");
		const blocks = (recorded("thinking").body as { content: { signature?: string }[] }).content;
		const original = (thinking.requests[1].body.messages as { content: { signature?: string }[] }[])[1].content;
		const altered = (thinking.requests[2].body.messages as { content: { signature?: string }[] }[])[1].content;
		expect(original).toEqual(blocks);
		expect(altered[0].signature).toHaveLength(blocks[0].signature!.length);
		expect([...altered[0].signature!].filter((char, index) => char !== blocks[0].signature![index])).toHaveLength(1);
		expect(altered[1]).toEqual(blocks[1]);
	});
});

describe("Claude route", () => {
	it("validates the target, key, model and closed case list without copying caller prompts", () => {
		const body = { site: "https://api.example.com/", key: KEY, model: MODEL, case: "C1", prompt: "attacker prompt", max_tokens: 99999 };
		expect(parseClaudeCaseRequest(body)).toEqual({ ok: true, value: input("C1") });
		for (const override of [{ site: "http://api.example.com" }, { site: "https://127.0.0.1" }, { site: "https://localhost" }, { key: "bad" }, { key: "key with spaces" }, { model: " " }, { model: "a".repeat(101) }, { case: "C11" }]) expect(parseClaudeCaseRequest({ ...body, ...override }).ok).toBe(false);
	});

	it("limits caller IP first and logs only the permitted fields without touching persistence", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetch = vi.fn(async () => reply(text(KEY)));
		vi.stubGlobal("fetch", fetch);
		const ip = vi.fn(async () => ({ success: false }));
		const host = vi.fn(async () => ({ success: true }));
		const env = { IP_LIMITER: { limit: ip }, HOST_LIMITER: { limit: host } } as unknown as Env;
		const request = (): Request<unknown, IncomingRequestCfProperties> => new Request("https://gpt.ziikoo.app/api/claude-case", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify({ site: "https://api.example.com", key: KEY, model: MODEL, case: "C1" }) });
		expect((await worker.fetch(request(), env, {} as ExecutionContext)).status).toBe(429);
		expect(host).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		ip.mockResolvedValue({ success: true });
		const response = await worker.fetch(request(), env, {} as ExecutionContext);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: "C1", verdict: "pass", preview: "[REDACTED]" });
		expect(host).toHaveBeenCalledWith({ key: "api.example.com" });
		expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ host: "api.example.com", case: "C1", verdict: "pass", status: 200, ms: expect.any(Number) });
		expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
		host.mockResolvedValue({ success: false });
		expect((await worker.fetch(request(), env, {} as ExecutionContext)).status).toBe(429);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

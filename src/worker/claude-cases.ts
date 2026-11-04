import { getQuestion, instantiate } from "../../questions/index.ts";
import type { CaseCall, ClaudeCaseResult, MessageSource } from "../shared/claude-cases.ts";
import { fetchModels } from "./models.ts";
import { DEFAULT_LIMITS, MAX_BODY_BYTES, UA } from "./probe.ts";
import { redact } from "./redact.ts";
import type { ClaudeCaseCommand } from "./request.ts";

export type ClaudeCaseDeps = {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	limit: () => Promise<{ success: boolean }>;
	now: () => number;
};

export class ClaudeCaseRateLimited extends Error {}

type RecordValue = Record<string, unknown>;
type Reply = { status: number | null; body: RecordValue; text: string; streamOk: boolean; ttftMs: number | null; complete: boolean };
const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
const WEATHER = { name: "get_weather", description: "Get the weather at a location.", input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } };
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
const content = (body: RecordValue): RecordValue[] => Array.isArray(body.content) ? body.content.map(record) : [];
const answer = (body: RecordValue): string => content(body).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
const clientError = (status: number | null) => status !== null && status >= 400 && status < 500;

function sourceOf(id: unknown): MessageSource | null {
	if (typeof id !== "string") return null;
	if (id.startsWith("msg_bdrk_")) return "bedrock";
	if (id.startsWith("msg_vrtx_")) return "vertex";
	return id.startsWith("msg_01") ? "anthropic" : "other";
}

function requestIdOf(response: Response, key: string): string | null {
	const id = response.headers.get("request-id");
	return id !== null && /^[A-Za-z0-9_-]{1,128}$/.test(id) && redact(id, key) === id ? id : null;
}

async function readReply(response: Response, start: number, deps: ClaudeCaseDeps, streaming: boolean): Promise<Reply> {
	const result: Reply = { status: response.status, body: {}, text: "", streamOk: false, ttftMs: null, complete: true };
	const reader = response.body?.getReader();
	if (!reader) return result;
	const decoder = new TextDecoder();
	let bytes = 0;
	let buffer = "";
	let phase = 0;
	let invalid = false;
	const consume = (block: string) => {
		const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
		if (!data) return;
		let parsed: RecordValue;
		try { parsed = record(JSON.parse(data)); } catch { invalid = true; return; }
		if (parsed.type === "error") invalid = true;
		if (parsed.type === "message_start") {
			if (phase !== 0) invalid = true;
			phase = 1;
			result.body = record(parsed.message);
		}
		if (parsed.type === "content_block_delta" && record(parsed.delta).type === "text_delta") {
			if (phase !== 1 && phase !== 2) invalid = true;
			phase = 2;
			const delta = record(parsed.delta).text;
			if (typeof delta !== "string") { invalid = true; return; }
			if (delta.length > 0 && result.ttftMs === null) result.ttftMs = deps.now() - start;
			result.text += delta;
		}
		if (parsed.type === "message_stop") {
			if (phase !== 2) invalid = true;
			phase = 3;
		}
	};
	try {
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			bytes += next.value.byteLength;
			if (bytes > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new Error("Response too large");
			}
			buffer += decoder.decode(next.value, { stream: true });
			if (streaming) {
				let boundary = /\r?\n\r?\n/.exec(buffer);
				while (boundary) {
					consume(buffer.slice(0, boundary.index));
					buffer = buffer.slice(boundary.index + boundary[0].length);
					boundary = /\r?\n\r?\n/.exec(buffer);
				}
			}
		}
		buffer += decoder.decode();
		if (streaming) {
			if (buffer.trim()) consume(buffer);
			result.streamOk = !invalid && phase === 3 && result.ttftMs !== null;
		} else {
			try { result.body = record(JSON.parse(buffer)); } catch { result.body = {}; }
			result.text = answer(result.body);
		}
		return result;
	} finally {
		reader.releaseLock();
	}
}

function freshTokens(body: RecordValue): { fresh: number; read: number } | null {
	const usage = record(body.usage);
	const input = count(usage.input_tokens);
	const created = count(usage.cache_creation_input_tokens ?? 0);
	const read = count(usage.cache_read_input_tokens);
	return input === null || created === null || read === null ? null : { fresh: input + created, read };
}

export async function runClaudeCase(input: ClaudeCaseCommand, deps: ClaudeCaseDeps): Promise<ClaudeCaseResult> {
	const result: ClaudeCaseResult = { id: input.case, verdict: "fail", note: "响应未满足用例要求", preview: null, source: null, calls: [] };
	const finish = (pass: boolean, note?: string) => {
		result.verdict = pass ? "pass" : "fail";
		if (note) result.note = note;
		else if (pass) result.note = "响应满足用例要求";
		return result;
	};
	const capture = (reply: Reply) => {
		if (reply.text) result.preview = [...redact(reply.text, input.key)].slice(0, 70).join("");
		result.source = sourceOf(reply.body.id) ?? result.source;
	};
	const call = async (path: string, init: RequestInit, streaming = false): Promise<Reply> => {
		if (!(await deps.limit()).success) throw new ClaudeCaseRateLimited();
		const start = deps.now();
		const meta: CaseCall = { status: null, requestId: null, ms: 0 };
		result.calls.push(meta);
		try {
			const response = await deps.fetch(`${input.origin}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(DEFAULT_LIMITS.timeoutMs) });
			meta.status = response.status;
			meta.requestId = requestIdOf(response, input.key);
			const reply = await readReply(response, start, deps, streaming);
			capture(reply);
			return reply;
		} catch {
			return { status: meta.status, body: {}, text: "", streamOk: false, ttftMs: null, complete: false };
		} finally {
			meta.ms = Math.max(0, deps.now() - start);
		}
	};
	const messages = [{ role: "user", content: "Reply with exactly OK" }];
	const send = (body: RecordValue = {}, path = "/v1/messages") => call(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": input.key, "anthropic-version": "2023-06-01", "User-Agent": UA },
		body: JSON.stringify({ model: input.model, max_tokens: 32, messages, ...body }),
	}, body.stream === true);
	const ok = (reply: Reply) => reply.status === 200 && reply.complete;
	const expectedStatus = /opus-5-5|sonnet-5-5/.test(input.model) ? 400 : 200;
	switch (input.case) {
		case "P3":
			return { ...result, verdict: "untested", note: "批量接口会创建异步任务并计费，本站不测" };
		case "P1": {
			if (!(await deps.limit()).success) throw new ClaudeCaseRateLimited();
			const start = deps.now();
			const meta: CaseCall = { status: null, requestId: null, ms: 0 };
			result.calls.push(meta);
			try {
				const models = await fetchModels(input, { fetch: async (url, init) => {
					const response = await deps.fetch(url, init);
					meta.status = response.status;
					meta.requestId = requestIdOf(response, input.key);
					return response;
				} });
				return finish(models.ok && models.models.includes(input.model));
			} finally {
				meta.ms = Math.max(0, deps.now() - start);
			}
		}
		case "C1": {
			const reply = await send();
			return finish(ok(reply) && reply.body.type === "message" && Array.isArray(reply.body.content) && typeof reply.body.usage === "object" && reply.body.usage !== null && !Array.isArray(reply.body.usage));
		}
		case "C2": {
			const replies: Reply[] = [];
			for (let attempt = 0; attempt < 3; attempt++) replies.push(await send({ stream: true }));
			return finish(replies.every((reply) => ok(reply) && reply.streamOk), `首字耗时 ms：${replies.map((reply) => reply.ttftMs ?? "未取得").join("、")}`);
		}
		case "C3": {
			const reply = await send({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: RED_PNG } }, { type: "text", text: "What is the main color of this image? Reply with the color in English." }] }] });
			return finish(ok(reply) && /\bred\b/i.test(reply.text));
		}
		case "C4": {
			const reply = await send({ max_tokens: 128, messages: [{ role: "user", content: 'Return exactly {"name":"Alice","age":30}.' }], output_config: { format: { type: "json_schema", schema: { type: "object", properties: { name: { type: "string" }, age: { type: "integer" } }, required: ["name", "age"], additionalProperties: false } } } });
			return finish(ok(reply) && reply.text === '{"name":"Alice","age":30}');
		}
		case "C5": {
			const reply = await send({ max_tokens: 256, tools: [WEATHER], tool_choice: { type: "tool", name: "get_weather" }, messages: [{ role: "user", content: "Get the weather in Paris." }] });
			return finish(reply.complete && reply.status === expectedStatus);
		}
		case "C6": {
			const firstMessages = [{ role: "user", content: "Call get_weather to get the weather in Paris." }];
			const body = { max_tokens: 1024, tools: [WEATHER], messages: firstMessages };
			const first = await send(body);
			const tools = content(first.body).filter((block) => block.type === "tool_use");
			if (!ok(first) || tools.length === 0 || tools.some((block) => block.name !== "get_weather" || typeof block.id !== "string")) return finish(false);
			const reply = await send({ ...body, messages: [...firstMessages, { role: "assistant", content: first.body.content }, { role: "user", content: tools.map((block) => ({ type: "tool_result", tool_use_id: block.id, content: "Sunny, 20 degrees Celsius." })) }] });
			return finish(ok(reply));
		}
		case "C7": {
			const reply = await send({ thinking: { type: "disabled" } });
			return finish(reply.complete && reply.status === expectedStatus);
		}
		case "C8": {
			const firstMessages = [{ role: "user", content: "Think through 17 times 23, then give the answer." }];
			const body = { max_tokens: 4096, thinking: { type: "adaptive" }, messages: firstMessages };
			const first = await send(body);
			const blocks = content(first.body);
			const signed = blocks.findIndex((block) => block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0);
			if (!ok(first) || signed < 0) return finish(false, "未取得思考签名");
			const replay = (replyBlocks: RecordValue[]) => send({ ...body, messages: [...firstMessages, { role: "assistant", content: replyBlocks }, { role: "user", content: "Reply with exactly OK." }] });
			const original = await replay(blocks);
			const signature = String(blocks[signed].signature);
			const changed = blocks.map((block, index) => index === signed ? { ...block, signature: (signature[0] === "A" ? "B" : "A") + signature.slice(1) } : block);
			const tampered = await replay(changed);
			return finish(ok(original) && tampered.complete && clientError(tampered.status));
		}
		case "C9": {
			const seed = crypto.getRandomValues(new Uint32Array(1))[0];
			const question = instantiate(getQuestion("long-prefix")!, seed);
			const body = { max_tokens: 32, cache_control: { type: "ephemeral" }, messages: [{ role: "user", content: `${question.prompt}\n\nReply with exactly OK.` }] };
			const replies: Reply[] = [];
			for (let attempt = 0; attempt < 5; attempt++) replies.push(await send(body));
			const warm = freshTokens(replies[0].body);
			const hits = replies.slice(1).map((reply) => {
				const tokens = freshTokens(reply.body);
				return warm && warm.fresh >= 4096 && tokens ? Math.max(0, 1 - tokens.fresh / warm.fresh) : null;
			});
			const reads = replies.map((reply) => freshTokens(reply.body)?.read ?? "未取得");
			return finish(replies.every(ok) && hits.every((hit) => hit !== null && hit >= 0.9), `freshHit：${hits.map((hit) => hit === null ? "未取得" : `${(hit * 100).toFixed(1)}%`).join("、")}；cache_read：${reads.join("、")}`);
		}
		case "C10": {
			await send();
			const reply = await send({ max_tokens: undefined }, "/v1/messages/count_tokens");
			if (reply.status === 404) { result.verdict = "gap"; result.note = "中转未暴露同路径"; }
			else finish(ok(reply) && (count(reply.body.input_tokens) ?? 0) > 0);
			if (result.source === "bedrock") result.note += "；无法测 Mantle";
			return result;
		}
		case "P2": {
			const reply = await send({ max_tokens: undefined });
			const requestId = result.calls[0].requestId;
			return finish(reply.complete && clientError(reply.status) && (Boolean(requestId?.startsWith("req_")) || Object.hasOwn(reply.body, "request_id") || Object.hasOwn(record(reply.body.error), "request_id")));
		}
	}
}

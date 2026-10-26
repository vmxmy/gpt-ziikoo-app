import { afterEach, describe, expect, it, vi } from "vitest";
import { probeHtml } from "../../src/web/api.ts";

const target = { site: "https://api.example.com", key: "sk-test-12345678" };
const RESPONSE = { ok: false, reason: "timeout", httpStatus: null };

function serve(parts: string[]) {
	const bodies: unknown[] = [];
	const encoder = new TextEncoder();
	vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const part of parts) controller.enqueue(encoder.encode(part));
				controller.close();
			},
		});
		return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
	});
	return bodies;
}

describe("probeHtml", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("asks for progress, hands each progress line over and returns the result line, whatever the chunk boundaries", async () => {
		const bodies = serve(['{"type":"start","timeoutMs":300000}\n{"type":"pro', 'gress","chars":0}\n', `${JSON.stringify({ type: "result", response: RESPONSE })}\n`]);
		const seen: unknown[] = [];
		const outcome = await probeHtml(target, "gpt-6-astra", "responses", null, 7, new AbortController().signal, (line) => seen.push(line));
		expect(bodies).toEqual([expect.objectContaining({ question: "pelican-svg", seed: 7, progress: true })]);
		expect(seen).toEqual([
			{ type: "start", timeoutMs: 300_000 },
			{ type: "progress", chars: 0 },
		]);
		expect(outcome).toEqual({ kind: "response", response: RESPONSE });
	});

	it("treats a stream cut off before the result line as a network error", async () => {
		serve(['{"type":"start","timeoutMs":300000}\n']);
		const outcome = await probeHtml(target, "gpt-6-astra", "responses", null, 7, new AbortController().signal, () => {});
		expect(outcome).toEqual({ kind: "network_error" });
	});
});

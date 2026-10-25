import { describe, expect, it } from "vitest";
import { fetchModels, type ModelsInput } from "../../src/worker/models.ts";

const KEY = "sk-test-12345678";

function upstream(status: number, body: string) {
	const requests: { url: string; init: RequestInit }[] = [];
	const fetch = async (url: string, init: RequestInit) => {
		requests.push({ url, init });
		return new Response(body, { status });
	};
	return { deps: { fetch }, requests };
}

const input = (overrides: Partial<ModelsInput> = {}): ModelsInput => ({ origin: "https://api.example.com", key: KEY, ...overrides });

describe("fetchModels", () => {
	it("dedupes, truncates ids to 100 chars and caps the list at 500", async () => {
		const long = "m".repeat(150);
		const data = [
			{ id: "gpt-6-astra" },
			{ id: "gpt-6-astra" },
			{ id: long },
			{ object: "model" },
			...Array.from({ length: 600 }, (_, i) => ({ id: `model-${i}` })),
		];
		const { deps, requests } = upstream(200, JSON.stringify({ object: "list", data }));
		const result = await fetchModels(input(), deps);
		expect(result).toEqual({ ok: true, models: [...new Set(["gpt-6-astra", long.slice(0, 100), ...Array.from({ length: 600 }, (_, i) => `model-${i}`)])].slice(0, 500) });
		expect(requests[0].url).toBe("https://api.example.com/v1/models");
		expect(requests[0].init.headers).toEqual({ "User-Agent": expect.any(String), Authorization: `Bearer ${KEY}`, Accept: "application/json" });
	});

	it("maps 401 to unauthorized", async () => {
		const { deps } = upstream(401, JSON.stringify({ error: { message: "Incorrect API key" } }));
		expect(await fetchModels(input(), deps)).toEqual({ ok: false, reason: "unauthorized", httpStatus: 401 });
	});

	it("returns bad_response when the body is not JSON", async () => {
		const { deps } = upstream(200, "<html>OK</html>");
		expect(await fetchModels(input(), deps)).toEqual({ ok: false, reason: "bad_response", httpStatus: 200 });
	});
});

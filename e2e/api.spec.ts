import type { APIRequestContext } from "@playwright/test";
import type { HistoryRawResponse, HistoryResponse } from "../src/shared/types.ts";
import { expect, test } from "./fixtures.ts";

// .invalid never resolves, so a validation regression cannot send traffic to a real host.
const UNREACHABLE_SITE = "https://relay.example.invalid";

async function history(request: APIRequestContext, site: string, key: string): Promise<HistoryResponse> {
	return (await request.post("/api/history", { data: { site, key } })).json();
}

async function raw(request: APIRequestContext, site: string, key: string, runId: string): Promise<HistoryRawResponse> {
	return (await request.post("/api/history/raw", { data: { site, key, runId } })).json();
}

test("POST /api/probe 拒绝非法目标与参数", async ({ request }) => {
	const valid = { site: UNREACHABLE_SITE, key: `sk-e2e-${"a".repeat(24)}`, protocol: "responses", model: "mock-good", question: "thibault" };
	const cases: Record<string, object> = {
		"http 站点": { ...valid, site: "http://relay.example.invalid" },
		"IP 站点": { ...valid, site: "https://1.2.3.4" },
		localhost: { ...valid, site: "https://localhost" },
		过短密钥: { ...valid, key: "sk-1" },
		"非法 runId": { ...valid, runId: "not-a-uuid", stage: 1, seq: 1 },
	};
	for (const [name, data] of Object.entries(cases)) {
		const res = await request.post("/api/probe", { data });
		expect(res.status(), name).toBe(400);
		expect(await res.json(), name).toMatchObject({ error: "bad_request" });
	}
});

test("GET /api/questions 形状", async ({ request }) => {
	const res = await request.get("/api/questions");
	expect(res.status()).toBe(200);
	const list: unknown[] = await res.json();
	expect(list.length).toBeGreaterThan(0);
	for (const q of list) {
		expect(q).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				version: expect.any(Number),
				title: expect.any(String),
				measures: expect.any(String),
				kind: expect.any(String),
				prompt: expect.any(String),
				expectedLabel: expect.any(String),
				calibratedModels: expect.any(Array),
				failureHint: expect.any(String),
			}),
		);
		expect(q).not.toHaveProperty("scorer");
	}
});

test("错误方法返回 405,预检不放行跨域", async ({ request }) => {
	const get = await request.get("/api/probe");
	expect(get.status()).toBe(405);
	expect(get.headers()["allow"]).toBe("POST");
	const preflight = await request.fetch("/api/probe", {
		method: "OPTIONS",
		headers: { Origin: "https://third-party.example", "Access-Control-Request-Method": "POST" },
	});
	expect(preflight.headers()["access-control-allow-origin"]).toBeUndefined();
});

test("页面有 CSP,接口有 no-store 与 nosniff", async ({ request }) => {
	const page = await request.get("/");
	expect(page.headers()["content-security-policy"]).toBeTruthy();
	for (const res of [await request.get("/api/questions"), await request.post("/api/probe", { data: {} })]) {
		expect(res.headers()["cache-control"]).toContain("no-store");
		expect(res.headers()["x-content-type-options"]).toBe("nosniff");
	}
});

test("站点回显密钥时,原始数据已脱敏", async ({ request, site, key }) => {
	const runId = crypto.randomUUID();
	const probe = (model: string, stage: number) =>
		request.post("/api/probe", { data: { site, key, protocol: "responses", model, question: "thibault", runId, stage, seq: 1 } });
	expect(await (await probe("mock-good", 1)).json()).toMatchObject({ ok: true, correct: true });
	// Only a valid response creates the object, and it is written after the reply; an echo call
	// that lands before the object exists is dropped instead of stored.
	await expect.poll(async () => (await history(request, site, key)).runs.length).toBe(1);
	const echo = await (await probe("mock-echo", 2)).text();
	expect(JSON.parse(echo)).toMatchObject({ ok: false, reason: "upstream_error", httpStatus: 500 });
	expect(echo).not.toContain(key);
	await expect.poll(async () => (await raw(request, site, key, runId)).calls.length).toBe(2);
	const stored = JSON.stringify(await raw(request, site, key, runId));
	expect(stored).toContain("[REDACTED]");
	expect(stored).not.toContain(key);
});

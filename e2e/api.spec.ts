import type { APIRequestContext } from "@playwright/test";
import type { HistoryRawResponse, HistoryResponse, ProbeFail, ProbeOk } from "../src/shared/types.ts";
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
		自由题面: { ...valid, question: "1+1=?" },
		未知协议: { ...valid, protocol: "grpc" },
		"runId 缺 stage 与 seq": { ...valid, runId: crypto.randomUUID() },
		"seed 超出范围": { ...valid, question: "candy-var", seed: 4294967296 },
		"seed 不是整数": { ...valid, question: "candy-var", seed: 1.5 },
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
	expect(list).toContainEqual(expect.objectContaining({ id: "candy-var", generator: "candy" }));
});

test("历史接口拒绝缺参数的请求", async ({ request }) => {
	for (const path of ["/api/history", "/api/history/raw", "/api/history/delete"]) {
		const res = await request.post(path, { data: {} });
		expect(res.status(), path).toBe(400);
		expect(await res.json(), path).toMatchObject({ error: "bad_request" });
	}
	const res = await request.post("/api/history/raw", { data: { site: UNREACHABLE_SITE, key: `sk-e2e-${"a".repeat(24)}`, runId: "not-a-uuid" } });
	expect(res.status()).toBe(400);
});

test("错误方法返回 405,预检不放行跨域", async ({ request }) => {
	for (const path of ["/api/probe", "/api/history", "/api/history/raw", "/api/history/delete"]) {
		const get = await request.get(path);
		expect(get.status(), path).toBe(405);
		expect(get.headers()["allow"], path).toBe("POST");
	}
	const post = await request.post("/api/questions", { data: {} });
	expect(post.status()).toBe(405);
	expect(post.headers()["allow"]).toBe("GET");
	const preflight = await request.fetch("/api/probe", {
		method: "OPTIONS",
		headers: { Origin: "https://third-party.example", "Access-Control-Request-Method": "POST" },
	});
	expect(preflight.headers()["access-control-allow-origin"]).toBeUndefined();
});

test("页面有 CSP,接口有 no-store 与 nosniff", async ({ request }) => {
	const page = await request.get("/");
	const csp = page.headers()["content-security-policy"] ?? "";
	expect(csp).toMatch(/script-src 'self'(;|$)/);
	for (const loose of ["'unsafe-inline'", "'unsafe-eval'", "http"]) expect(csp).not.toContain(loose);
	for (const res of [await request.get("/api/questions"), await request.post("/api/probe", { data: {} })]) {
		expect(res.headers()["cache-control"]).toContain("no-store");
		expect(res.headers()["x-content-type-options"]).toBe("nosniff");
	}
});

// No runId, so nothing is stored; one probe per failure keeps this within the host budget in run.spec.
test("站点失败状态映射为 reason 与 httpStatus", async ({ request, site, key }) => {
	const cases: Record<string, Omit<ProbeFail, "ok">> = {
		"mock-429": { reason: "rate_limited", httpStatus: 429 },
		"mock-500": { reason: "upstream_error", httpStatus: 500 },
		"mock-missing": { reason: "not_found", httpStatus: 404 },
		"mock-403": { reason: "forbidden", httpStatus: 403 },
		"mock-empty": { reason: "bad_response", httpStatus: 200 },
		"mock-html": { reason: "bad_response", httpStatus: 200 },
		"mock-redirect": { reason: "upstream_error", httpStatus: 302 },
		"mock-stream-error": { reason: "upstream_error", httpStatus: 200 },
	};
	for (const [model, expected] of Object.entries(cases)) {
		const res = await request.post("/api/probe", { data: { site, key, protocol: "responses", model, question: "thibault" } });
		expect(res.status(), model).toBe(200);
		expect(await res.json(), model).toMatchObject({ ok: false, ...expected });
	}
});

test("站点回显密钥时,原始数据已脱敏", async ({ request, site, key }) => {
	const runId = crypto.randomUUID();
	const probe = (model: string, stage: number) =>
		request.post("/api/probe", { data: { site, key, protocol: "responses", model, question: "thibault", runId, stage, seq: 1 } });
	expect(await (await probe("mock-good", 1)).json()).toMatchObject({
		ok: true,
		correct: true,
		idShape: "hex",
		reasoningTokens: 192,
		cachedTokens: 0,
		streamed: true,
		ttftMs: expect.any(Number),
	});
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

// seed 12345 is 24 total, 11 and 13; mock-wrong answers one too many for the total and the first count.
test("candy-var 按 seed 出题,mock 解出后答对,seed 随调用落库", async ({ request, site, key }) => {
	const runId = crypto.randomUUID();
	const probe = async (model: string, extra: object) =>
		(await request.post("/api/probe", { data: { site, key, protocol: "responses", model, question: "candy-var", seed: 12345, ...extra } })).json();
	expect(await probe("mock-good", { runId, stage: 1, seq: 1 })).toMatchObject({ ok: true, correct: true, note: "ok" });
	expect(await probe("mock-wrong", {})).toMatchObject({ ok: true, correct: false, note: "want 24/11/13 got 25/12/13" });
	await expect.poll(async () => (await raw(request, site, key, runId)).calls.length).toBe(1);
	expect((await raw(request, site, key, runId)).calls[0]).toMatchObject({ questionId: "candy-var", seed: 12345, correct: true });
});

test("解析 id 形态、缓存用量、首字时间与超限截断", async ({ request, site, key }) => {
	const probe = async (model: string, run: object = {}) =>
		(await request.post("/api/probe", { data: { site, key, protocol: "responses", model, question: "thibault", ...run } })).json();
	expect(await probe("mock-ft"), "mock-ft").toMatchObject({ ok: true, idShape: "ft" });
	expect(await probe("mock-b64"), "mock-b64").toMatchObject({ ok: true, idShape: "base64" });
	expect(await probe("mock-cached"), "mock-cached").toMatchObject({ ok: true, promptTokens: 1280, cachedTokens: 1024 });
	// mock-slow waits 80 ms before the first delta and 400 ms before each of the other four.
	const slow: ProbeOk = await probe("mock-slow");
	expect(slow).toMatchObject({ ok: true, totalMs: expect.any(Number), ttftMs: expect.any(Number) });
	expect(slow.ttftMs).toBeLessThan(slow.totalMs);
	expect(slow.totalMs).toBeGreaterThanOrEqual(1600);
	const runId = crypto.randomUUID();
	expect(await probe("mock-big", { runId, stage: 1, seq: 1 }), "mock-big").toMatchObject({ ok: true });
	await expect.poll(async () => (await raw(request, site, key, runId)).calls.length).toBe(1);
	const [big] = (await raw(request, site, key, runId)).calls;
	expect(big).toMatchObject({ truncated: true, usage: null });
});

test("只有带 runId 的有效响应才建立对象,不存在与删除后同形", async ({ request, site, key }) => {
	const runId = crypto.randomUUID();
	const empty = async () => {
		expect(await history(request, site, key)).toEqual({ runs: [] });
		expect(await raw(request, site, key, runId)).toEqual({ calls: [] });
	};
	const probe = (model: string, run: object) =>
		request.post("/api/probe", { data: { site, key, protocol: "responses", model, question: "thibault", ...run } });
	await empty();
	expect(await (await probe("mock-401", { runId, stage: 1, seq: 1 })).json()).toMatchObject({ ok: false, reason: "unauthorized" });
	expect(await (await probe("mock-good", {})).json()).toMatchObject({ ok: true, correct: true });
	await empty();
	expect(await (await probe("mock-good", { runId, stage: 1, seq: 1, attempt: 2 })).json()).toMatchObject({ ok: true });
	await expect.poll(async () => (await history(request, site, key)).runs.length).toBe(1);
	// The 401 shares the runId, so a single stored call proves a failure before the object exists is dropped.
	const { calls } = await raw(request, site, key, runId);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({ ok: true, attempt: 2 });
	expect((await request.post("/api/history/delete", { data: { site, key } })).status()).toBe(200);
	await empty();
});

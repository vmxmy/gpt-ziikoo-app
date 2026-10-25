import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { default: worker } = await import("../../src/worker/index.ts");

const KEY = "sk-test-12345678";

function limiter(success: boolean) {
	const keys: string[] = [];
	return { keys, limit: async ({ key }: RateLimitOptions) => (keys.push(key), { success }) };
}

function harness(ipAllowed: boolean) {
	const ip = limiter(ipAllowed);
	const host = limiter(false);
	const reached = { target: false };
	const env = { PEPPER: "pepper-for-tests", IP_LIMITER: ip, HOST_LIMITER: host };
	const ctx = {
		waitUntil: () => {},
		exports: {
			Target: {
				idFromName: (name: string) => name,
				get: () => {
					reached.target = true;
					throw new Error("Target must not be reached");
				},
			},
		},
	};
	// Only the bindings these routes touch are faked; the generated Env and ExecutionContext types are far wider.
	const call = (path: string, body: object) =>
		worker.fetch(
			new Request(`https://gpt.ziikoo.app${path}`, {
				method: "POST",
				headers: { "CF-Connecting-IP": "203.0.113.7" },
				body: JSON.stringify(body),
			}),
			env as unknown as Env,
			ctx as unknown as ExecutionContext,
		);
	return { call, ip, host, reached };
}

describe("worker rate limits", () => {
	it.each(["/api/history", "/api/history/raw", "/api/history/delete", "/api/models"])("limits %s by caller IP before touching storage", async (path) => {
		const { call, ip, reached } = harness(false);
		const res = await call(path, { site: "https://api.example.com", key: KEY, runId: "00000000-0000-4000-8000-00000000000a" });
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
		expect(ip.keys).toEqual(["203.0.113.7"]);
		expect(reached.target).toBe(false);
	});

	it("keys the target-host limit by hostname without the port", async () => {
		const { call, host } = harness(true);
		const res = await call("/api/probe", {
			site: "https://api.example.com:8443",
			key: KEY,
			protocol: "responses",
			model: "gpt-6-astra",
			question: "thibault",
		});
		expect(res.status).toBe(429);
		expect(host.keys).toEqual(["api.example.com"]);
	});
});

describe("frame host", () => {
	it("serves the sandboxed frame document with its own CSP", async () => {
		const res = await worker.fetch(new Request("https://gpt.ziikoo.app/api/frame"), {} as Env, {} as ExecutionContext);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("sandbox allow-scripts");
		expect(await res.text()).toContain("document.write");
	});
});

describe("watch create", () => {
	function watchHarness(reserved: string) {
		const reached = { watch: false };
		const env = { PEPPER: "pepper-for-tests", IP_LIMITER: limiter(true), HOST_LIMITER: limiter(true) };
		const ctx = {
			waitUntil: () => {},
			exports: {
				Watch: {
					idFromName: (name: string) => name,
					get: () => ({
						create: async () => {
							reached.watch = true;
							throw new Error("Watch must not be reached");
						},
					}),
				},
				WatchRegistry: { idFromName: (name: string) => name, get: () => ({ reserve: async () => reserved }) },
			},
		};
		const call = (body: object) =>
			worker.fetch(
				new Request("https://gpt.ziikoo.app/api/watch", {
					method: "POST",
					headers: { "CF-Connecting-IP": "203.0.113.7" },
					body: JSON.stringify(body),
				}),
				env as unknown as Env,
				ctx as unknown as ExecutionContext,
			);
		return { call, reached };
	}

	const body = { site: "https://api.example.com", key: KEY, model: "gpt-6-astra", protocol: "responses", intervalMin: 5, consent: true };

	it("refuses without consent", async () => {
		const res = await watchHarness("ok").call({ ...body, consent: false });
		expect(res.status).toBe(400);
	});

	it("names the bad field", async () => {
		const res = await watchHarness("ok").call({ ...body, key: "short" });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "bad_request", field: "key" });
	});

	it("stops at the site-wide cap before calling the site", async () => {
		const { call, reached } = watchHarness("total_limit");
		const res = await call(body);
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "watch_limit", message: "本站持续监测已满，请稍后再试" });
		expect(reached.watch).toBe(false);
	});
});

describe("board request parsing", () => {
	const validBoard = "AbCdEfGhIjKlMnOpQrSt12";
	const validToken = "A".repeat(43);

	it("accepts a valid board view request", async () => {
		const { parseBoardView } = await import("../../src/worker/request.ts");
		expect(parseBoardView({ board: validBoard })).toEqual({ ok: true, value: validBoard });
	});

	it("rejects board view with invalid board code", async () => {
		const { parseBoardView } = await import("../../src/worker/request.ts");
		expect(parseBoardView({ board: "short" }).ok).toBe(false);
		expect(parseBoardView({}).ok).toBe(false);
	});

	it("accepts a valid board adopt request", async () => {
		const { parseBoardAdopt } = await import("../../src/worker/request.ts");
		expect(parseBoardAdopt({ tokens: [validToken] })).toEqual({ ok: true, value: { tokens: [validToken] } });
		expect(parseBoardAdopt({ board: validBoard, tokens: [validToken, validToken] })).toEqual({
			ok: true,
			value: { board: validBoard, tokens: [validToken, validToken] },
		});
	});

	it("rejects board adopt with invalid tokens", async () => {
		const { parseBoardAdopt } = await import("../../src/worker/request.ts");
		expect(parseBoardAdopt({ tokens: ["short"] }).ok).toBe(false);
		expect(parseBoardAdopt({ tokens: Array(31).fill(validToken) }).ok).toBe(false);
	});

	it("accepts a valid board move request", async () => {
		const { parseBoardMove } = await import("../../src/worker/request.ts");
		const another = "BbCdEfGhIjKlMnOpQrSt34";
		expect(parseBoardMove({ from: validBoard })).toEqual({ ok: true, value: { from: validBoard } });
		expect(parseBoardMove({ from: validBoard, into: another })).toEqual({ ok: true, value: { from: validBoard, into: another } });
	});

	it("rejects board move with invalid codes", async () => {
		const { parseBoardMove } = await import("../../src/worker/request.ts");
		expect(parseBoardMove({ from: "short" }).ok).toBe(false);
		expect(parseBoardMove({ from: validBoard, into: "x" }).ok).toBe(false);
	});

	it("accepts a valid board order request", async () => {
		const { parseBoardOrder } = await import("../../src/worker/request.ts");
		const another = "C".repeat(43);
		expect(parseBoardOrder({ board: validBoard, tokens: [validToken, another] })).toEqual({
			ok: true,
			value: { board: validBoard, tokens: [validToken, another] },
		});
	});

	it("rejects board order with duplicate tokens", async () => {
		const { parseBoardOrder } = await import("../../src/worker/request.ts");
		expect(parseBoardOrder({ board: validBoard, tokens: [validToken, validToken] }).ok).toBe(false);
	});
});


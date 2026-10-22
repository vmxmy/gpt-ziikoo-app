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
	it.each(["/api/history", "/api/history/raw", "/api/history/delete"])("limits %s by caller IP before touching storage", async (path) => {
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

	it("stops at the per-IP cap before calling the site", async () => {
		const { call, reached } = watchHarness("ip_limit");
		const res = await call(body);
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "watch_limit", message: "每个网络最多 6 个持续监测" });
		expect(reached.watch).toBe(false);
	});
});

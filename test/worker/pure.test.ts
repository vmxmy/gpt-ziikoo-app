import { describe, expect, it } from "vitest";
import type { Scorer } from "../../src/shared/types.ts";
import { objectId } from "../../src/worker/identity.ts";
import { redact } from "../../src/worker/redact.ts";
import { parseHistoryRequest } from "../../src/worker/request.ts";
import { score } from "../../src/worker/scorers.ts";
import { parseSite } from "../../src/worker/target-url.ts";

describe("score", () => {
	it("yes_no reads the leading word case-insensitively", () => {
		expect(score("  Yes, I know him.", { type: "yes_no", expected: "YES" })).toEqual({ correct: true, note: "YES" });
		expect(score("No, I don't.", { type: "yes_no", expected: "YES" })).toEqual({ correct: false, note: "NO" });
	});

	it("numbers requires every expected number", () => {
		const scorer: Scorer = { type: "numbers", expected: ["21", "9", "12"] };
		expect(score("共 21 颗:9 颗圆形,12 颗五角星", scorer)).toEqual({ correct: true, note: "ok" });
		expect(score("至少需要 21 颗", scorer)).toEqual({
			correct: false,
			note: 'missing ["9","12"]',
		});
	});

	it("contains matches a substring", () => {
		expect(score("the answer is 42", { type: "contains", expected: "42" })).toEqual({ correct: true, note: "ok" });
		expect(score("the answer is 41", { type: "contains", expected: "42" })).toEqual({ correct: false, note: "not found" });
	});
});

describe("parseSite", () => {
	it.each([
		"http://api.example.com",
		"https://127.0.0.1",
		"https://0x7f000001",
		"https://[::1]",
		"https://localhost",
		"https://app.localhost",
		"https://localhost.",
		"https://LOCALHOST..",
		"https://a.localhost.",
		"https://intranet.",
		"https://intranet",
		"https://user:pw@api.example.com",
		"not a url",
	])("rejects %s", (input) => {
		expect(parseSite(input)).toEqual({ ok: false });
	});

	it.each([
		"https://API.Example.com",
		"https://api.example.com/",
		"https://api.example.com/v1",
		"https://api.example.com/v1/",
		"https://api.example.com/v1/chat/completions",
		"https://api.example.com:443/v1/responses?x=1",
		"https://api.example.com./v1",
	])("normalises %s", (input) => {
		expect(parseSite(input)).toEqual({ ok: true, origin: "https://api.example.com", host: "api.example.com" });
	});

	it("keeps a non-default port in the origin but not in the rate-limit host", () => {
		expect(parseSite("https://api.example.com.:8443/v1")).toEqual({
			ok: true,
			origin: "https://api.example.com:8443",
			host: "api.example.com",
		});
	});
});

describe("redact", () => {
	const key = "sk-test-12345678";

	it("replaces the bare key and the Bearer form", () => {
		expect(redact(`Incorrect API key provided: ${key}. Header was Bearer ${key}`, key)).toBe(
			"Incorrect API key provided: [REDACTED]. Header was [REDACTED]",
		);
	});

	it("is backed by a key charset that JSON and HTML encoders leave unescaped", () => {
		const parse = (key: string) => parseHistoryRequest({ site: "https://api.example.com", key }).ok;
		expect(parse("sk-proj_abc.DEF-1234")).toBe(true);
		expect(["sk-test-1234\"5678", "sk-test-1234/5678", "sk-test-1234<5678"].map(parse)).toEqual([false, false, false]);
	});

	it("leaves text alone for keys shorter than 8 characters", () => {
		expect(redact("abc and abc", "abc")).toBe("abc and abc");
	});
});

describe("objectId", () => {
	const pepper = "pepper-for-tests";

	it("is HMAC-SHA256 over origin and key", async () => {
		expect(await objectId(pepper, "https://api.example.com", "sk-test-12345678")).toBe(
			"22941fd8daaca9e6238881d46bb5b43b0185a45fdf82c4eaff40fcd14662e27e",
		);
	});

	it("matches across spellings of one site and differs across keys", async () => {
		const a = parseSite("https://API.example.com/v1/");
		const b = parseSite("https://api.example.com");
		const c = parseSite("https://api.example.com.");
		if (!a.ok || !b.ok || !c.ok) throw new Error("site should parse");
		const idA = await objectId(pepper, a.origin, "sk-test-12345678");
		expect(await objectId(pepper, b.origin, "sk-test-12345678")).toBe(idA);
		expect(await objectId(pepper, c.origin, "sk-test-12345678")).toBe(idA);
		expect(await objectId(pepper, b.origin, "sk-test-87654321")).not.toBe(idA);
	});
});

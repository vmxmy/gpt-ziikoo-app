import { describe, expect, it } from "vitest";
import type { Scorer } from "../../src/shared/types.ts";
import { objectId } from "../../src/worker/identity.ts";
import { redact } from "../../src/worker/redact.ts";
import { parseHistoryRequest, parseProbeRequest } from "../../src/worker/request.ts";
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

	it("final_numbers reads only the last 答案 line, in order", () => {
		const scorer: Scorer = { type: "final_numbers", expected: ["21", "9", "12"] };
		expect(score("先摸 3 颗试试，共 24 种情况\n答案：总数=21，圆形=9，五角星形=12", scorer)).toEqual({ correct: true, note: "ok" });
		expect(score("推理…\n**答案: 总数=21，圆形=9，五角星形=12**", scorer)).toEqual({ correct: true, note: "ok" });
		expect(score("答案：总数=21，圆形=9，五角星形=12\n答案：总数=21，圆形=12，五角星形=9", scorer)).toEqual({
			correct: false,
			note: "want 21/9/12 got 21/12/9",
		});
		expect(score("答案：总数=21，圆形=9", scorer)).toEqual({ correct: false, note: "want 21/9/12 got 21/9" });
		expect(score("答案：总数=21，圆形=9，五角星形=12，另需 1 颗", scorer)).toEqual({
			correct: false,
			note: "want 21/9/12 got 21/9/12/1",
		});
		expect(score("21 颗：9 颗圆形，12 颗五角星", scorer)).toEqual({ correct: false, note: "want 21/9/12 got none" });
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

describe("parseProbeRequest seed", () => {
	const body = { site: "https://api.example.com", key: "sk-test-12345678", protocol: "responses", model: "m", question: "candy-var" };

	it.each([-1, 1.5, 4294967296, "1", null])("rejects seed %s", (seed) => {
		expect(parseProbeRequest({ ...body, seed })).toEqual({ ok: false, message: "seed 必须是 0 到 4294967295 的整数" });
	});

	it("instantiates a generator question for the seed, defaulting to 0", () => {
		const parsed = (b: object) => {
			const result = parseProbeRequest(b);
			if (!result.ok) throw new Error(result.message);
			const { seed, question } = result.value;
			return { seed, prompt: question.prompt, scorer: question.scorer };
		};
		const one = parsed({ ...body, seed: 1 });
		expect(one).toMatchObject({ seed: 1, scorer: { type: "final_numbers", expected: ["25", "6", "19"] } });
		expect(one.prompt).toContain("三种口味的巧克力：榛子味、草莓味、抹茶味");
		expect(parsed({ ...body, seed: 1 }).prompt).toBe(one.prompt);
		const sample = parsed(body);
		expect(sample).toMatchObject({ seed: 0, scorer: { type: "final_numbers", expected: ["24", "4", "20"] } });
		expect(sample.prompt).toContain("三种口味的软糖：葡萄味、橙子味、柠檬味");
		expect(parsed({ ...body, question: "thibault", seed: 5 })).toEqual({
			seed: null,
			prompt: "don't search the internet, do you know Thibault Sottiaux on X. answer yes or no",
			scorer: { type: "yes_no", expected: "YES" },
		});
	});
});

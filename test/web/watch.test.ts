import { describe, expect, it } from "vitest";
import { cardId, cardLabel, normalizeAlias, parseSite, parseTokens, parseWatchInput, protocolForModel, statusNotice } from "../../src/web/watch.ts";

const KEY = "sk-live-known-secret-0042";
const TOKEN = "A".repeat(43);

const input = (over: Partial<Parameters<typeof parseWatchInput>[0]> = {}) => ({
	site: "https://relay.example",
	alias: "",
	key: KEY,
	model: "gpt-6-astra",
	protocol: "responses" as const,
	intervalMin: 5 as const,
	consent: true,
	...over,
});

describe("parseWatchInput", () => {
	it("normalizes the key and alias into a create request", () => {
		const draft = parseWatchInput(input({ key: ` Bearer ${KEY} `, alias: "  主通道  " }));
		expect(draft).toEqual({
			ok: true,
			request: { site: "https://relay.example", key: KEY, model: "gpt-6-astra", protocol: "responses", intervalMin: 5, alias: "主通道", consent: true },
		});
	});

	it("reports each missing field on its own field", () => {
		expect(parseWatchInput(input({ site: "http://a.example" }))).toMatchObject({ ok: false, error: { field: "site" } });
		expect(parseWatchInput(input({ key: "" }))).toMatchObject({ ok: false, error: { field: "key" } });
		expect(parseWatchInput(input({ model: " " }))).toMatchObject({ ok: false, error: { field: "model" } });
		expect(parseWatchInput(input({ consent: false }))).toMatchObject({ ok: false, error: { field: "consent" } });
	});
});

describe("token storage", () => {
	it("keeps only well-formed tokens", () => {
		expect(parseTokens(null)).toEqual([]);
		expect(parseTokens("{not json")).toEqual([]);
		expect(parseTokens(JSON.stringify(["short", TOKEN, 3]))).toEqual([TOKEN]);
	});
});

describe("labels", () => {
	it("labels a card with host only when the alias is empty", () => {
		expect(cardLabel({ alias: "", host: "relay.example" })).toBe("relay.example");
		expect(cardLabel({ alias: "备用", host: "relay.example" })).toBe("备用（relay.example）");
		expect(cardId(TOKEN)).toHaveLength(8);
	});

	it("trims and caps the alias", () => {
		expect(normalizeAlias("  通道 A  ")).toBe("通道 A");
		expect(normalizeAlias("x".repeat(50))).toHaveLength(40);
	});
});

describe("statusNotice", () => {
	it("says nothing while running and explains paused and bad_key", () => {
		expect(statusNotice({ kind: "running" })).toBeNull();
		expect(statusNotice({ kind: "paused" })).toBe("已暂停");
		expect(statusNotice({ kind: "bad_key" })).toContain("密钥无效");
	});
});

describe("protocolForModel", () => {
	it("picks anthropic for a Claude model and leaves it again when the model changes", () => {
		expect(protocolForModel("claude-sonnet-5-5", "chat")).toBe("anthropic");
		expect(protocolForModel("anthropic/Claude-Opus-5", "responses")).toBe("anthropic");
		expect(protocolForModel("gpt-6-astra", "anthropic")).toBe("responses");
		expect(protocolForModel("gpt-6-astra", "chat")).toBe("chat");
	});
});

describe("parseSite", () => {
	it("accepts https only", () => {
		expect(parseSite(" https://relay.example/v1 ")).toEqual({ ok: true, site: "https://relay.example/v1", host: "relay.example" });
		expect(parseSite("http://relay.example")).toEqual({ ok: false, message: "只支持 https 地址" });
		expect(parseSite("relay.example")).toEqual({ ok: false, message: "请输入完整地址，例如 https://example.com" });
	});
});

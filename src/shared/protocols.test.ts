import { describe, expect, it } from "vitest";
import { protocolForModel, RACE_ORDER, raceProtocols } from "./protocols.ts";

describe("protocolForModel", () => {
	it("picks anthropic for a Claude model and leaves it again when the model changes", () => {
		expect(protocolForModel("claude-sonnet-5-5", "chat")).toBe("anthropic");
		expect(protocolForModel("anthropic/Claude-Opus-5", "responses")).toBe("anthropic");
		expect(protocolForModel("gpt-6-astra", "anthropic")).toBe("responses");
		expect(protocolForModel("gpt-6-astra", "chat")).toBe("chat");
	});

	it("picks gemini for a Gemini model and leaves it again when the model changes", () => {
		expect(protocolForModel("gemini-4-neon", "chat")).toBe("gemini");
		expect(protocolForModel("gpt-6-astra", "gemini")).toBe("responses");
	});
});

describe("raceProtocols", () => {
	it("races the model family's protocol against chat", () => {
		expect(raceProtocols("gemini-4-neon")).toEqual(["gemini", "chat"]);
		expect(raceProtocols("claude-sonnet-5-5")).toEqual(["anthropic", "chat"]);
		expect(raceProtocols("gpt-6-astra")).toEqual(["responses", "chat"]);
	});

	it("orders protocols with chat last", () => {
		expect(RACE_ORDER).toEqual(["responses", "anthropic", "gemini", "chat"]);
	});
});

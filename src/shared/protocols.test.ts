import { describe, expect, it } from "vitest";
import { protocolForModel } from "./protocols.ts";

describe("protocolForModel", () => {
	it("picks anthropic for a Claude model and leaves it again when the model changes", () => {
		expect(protocolForModel("claude-sonnet-5-5", "chat")).toBe("anthropic");
		expect(protocolForModel("anthropic/Claude-Opus-5", "responses")).toBe("anthropic");
		expect(protocolForModel("gpt-6-astra", "anthropic")).toBe("responses");
		expect(protocolForModel("gpt-6-astra", "chat")).toBe("chat");
	});
});

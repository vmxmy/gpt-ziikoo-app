import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadReport, escapeHtml, reportFileName } from "../../src/web/report.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("report text", () => {
	it("escapes HTML markup, ampersands and both quotes", () => {
		expect(escapeHtml(`<script title="a&b">'x'</script>`)).toBe("&lt;script title=&quot;a&amp;b&quot;&gt;&#39;x&#39;&lt;/script&gt;");
		expect(escapeHtml("&lt;中文&gt;\n")).toBe("&amp;lt;中文&amp;gt;\n");
		expect(escapeHtml("")).toBe("");
	});

	it("builds report names from safe host and model characters", () => {
		expect(reportFileName("relay.example", "claude/opus 5", "qps_bench")).toBe("relay.example_claude-opus-5_qps_bench.html");
		expect(reportFileName("relay.example", "claude-opus-5.5", "claude_protocol")).toBe("relay.example_claude-opus-5.5_claude_protocol.html");
		expect(reportFileName("relay/站点", 'model\\name:"<>|?*', "qps_bench")).toBe("relay---_model-name-------_qps_bench.html");
	});

	it("downloads a UTF-8 report as an attachment and revokes its URL", async () => {
		const link = { href: "", download: "", click: vi.fn() };
		const createElement = vi.fn().mockReturnValue(link);
		vi.stubGlobal("document", { createElement });
		const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report-test");
		const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

		downloadReport("<!doctype html><p>报告</p>", "report.html");

		expect(createElement).toHaveBeenCalledExactlyOnceWith("a");
		expect(link.href).toBe("blob:report-test");
		expect(link.download).toBe("report.html");
		expect(link.click).toHaveBeenCalledOnce();
		const blob = createUrl.mock.calls[0][0];
		if (!(blob instanceof Blob)) throw new Error("report download must use a Blob");
		expect(blob.type).toBe("application/octet-stream");
		const bytes = new Uint8Array(await blob.arrayBuffer());
		expect(Array.from(bytes.slice(0, 3))).toEqual([239, 187, 191]);
		expect(new TextDecoder().decode(bytes)).toBe("<!doctype html><p>报告</p>");
		expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:report-test");
		expect(link.click.mock.invocationCallOrder[0]).toBeLessThan(revokeUrl.mock.invocationCallOrder[0]);
	});
});

import { describe, expect, it } from "vitest";
import { fileHost, privacyFromStorage, siteLabel } from "../../src/web/privacy.ts";
import { reportFileName } from "../../src/web/report.ts";

describe("privacy mode", () => {
	it("stays on unless this browser stored off", () => {
		expect(privacyFromStorage(null)).toBe(true);
		expect(privacyFromStorage("on")).toBe(true);
		expect(privacyFromStorage("garbage")).toBe(true);
		expect(privacyFromStorage("off")).toBe(false);
	});

	it("hides the host on screen and in report file names", () => {
		expect(siteLabel("relay.example", true)).toBe("站点已隐藏");
		expect(siteLabel("relay.example", false)).toBe("relay.example");
		expect(reportFileName(fileHost("relay.example", true), "gpt-6", "qps_bench")).toBe("hidden-site_gpt-6_qps_bench.html");
		expect(reportFileName(fileHost("relay.example", false), "gpt-6", "qps_bench")).toBe("relay.example_gpt-6_qps_bench.html");
	});
});

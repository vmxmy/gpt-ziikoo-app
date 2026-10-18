import { defineConfig, devices } from "@playwright/test";
import type { E2eOptions } from "./e2e/fixtures.ts";

export default defineConfig<E2eOptions>({
	testDir: "e2e",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	retries: 1,
	// Every probing spec shares the mock host's 60-per-minute HOST_LIMITER budget; parallel workers
	// would spend it without the serial cooldown in run.spec seeing those probes.
	workers: 1,
	reporter: [["list"], ["html", { open: "never" }]],
	use: {
		baseURL: process.env.BASE_URL ?? "https://gpt.ziikoo.app",
		// Required for any test that probes; validated in the site fixture so --list works without it.
		mockUrl: process.env.MOCK_URL ?? "",
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		// Page checks only: the run and API specs would double the probes sent to the shared mock host.
		{ name: "mobile", use: { ...devices["Pixel 5"] }, testMatch: "page.spec.ts" },
	],
});

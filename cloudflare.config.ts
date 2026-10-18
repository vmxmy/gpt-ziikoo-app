import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "gpt-ziikoo-app",
		compatibilityDate: "2026-10-06",
		compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"],
		entrypoint,
		domains: ["gpt.ziikoo.app"],
		workersDev: false,
		previewUrls: false,
		triggers: [triggers.scheduled({ schedule: "* * * * *" })],
		assets: { runWorkerFirst: ["/api/*"] },
		exports: {
			Target: exports.durableObject({ storage: "sqlite" }),
			Monitor: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			PEPPER: bindings.secret(),
			GAOXIN_KEY: bindings.secret(),
			MONITOR_SITE: bindings.text("https://api.gaoxin.net.cn"),
			MONITOR_MODEL: bindings.text("gpt-6-astra"),
			IP_LIMITER: bindings.rateLimit({ namespace: "7101", simple: { limit: 150, period: 60 } }),
			HOST_LIMITER: bindings.rateLimit({ namespace: "7102", simple: { limit: 120, period: 60 } }),
		},
		observability: {
			enabled: true,
			logs: { enabled: true, invocationLogs: false, headSamplingRate: 1 },
			issues: { enabled: true },
		},
	},
});

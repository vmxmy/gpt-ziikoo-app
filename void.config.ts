import { defineConfig } from "void/config";

export default defineConfig({
	worker: {
		compatibility_date: "2026-10-06",
		compatibility_flags: ["nodejs_compat"],
	},
	inference: {
		bindings: {
			db: false,
			kv: false,
			storage: false,
			ai: false,
		},
	},
	cloudflare: {
		name: "gpt-ziikoo-void",
		workers_dev: false,
		preview_urls: false,
		routes: [{ pattern: "gpt.ziikoo.app", custom_domain: true }],
		ratelimits: [
			{ name: "IP_LIMITER", namespace_id: "7101", simple: { limit: 150, period: 60 } },
			{ name: "HOST_LIMITER", namespace_id: "7102", simple: { limit: 120, period: 60 } },
		],
		observability: {
			enabled: true,
			logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 },
		},
	},
});

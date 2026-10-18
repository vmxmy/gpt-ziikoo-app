import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "gpt-ziikoo-mock-relay",
		compatibilityDate: "2026-10-06",
		entrypoint,
		workersDev: true,
		// Request logs would capture the Authorization header, and the mock must not record keys.
		observability: { enabled: false },
	},
});

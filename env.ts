import { defineEnv, string } from "void/env";

export const env = defineEnv({
	PEPPER: string(),
	WATCH_ENC_KEY: string(),
	AUTH_GOOGLE_CLIENT_ID: string().optional(),
	AUTH_GOOGLE_CLIENT_SECRET: string().optional(),
	AUTH_GITHUB_CLIENT_ID: string().optional(),
	AUTH_GITHUB_CLIENT_SECRET: string().optional(),
});

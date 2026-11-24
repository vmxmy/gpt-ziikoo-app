import { defineEnv, string } from "void/env";

export const env = defineEnv({
	PEPPER: string(),
	WATCH_ENC_KEY: string(),
});

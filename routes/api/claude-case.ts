import { defineHandler } from "void";
import { handleClaudeCase } from "../../src/worker/index.ts";

export const POST = defineHandler((c) => handleClaudeCase(c.req.raw, c.env as unknown as Env, c.executionCtx));

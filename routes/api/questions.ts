import { defineHandler } from "void";
import { handleQuestions } from "../../src/worker/index.ts";

export const GET = defineHandler((c) => handleQuestions(c.req.raw, c.env as unknown as Env, c.executionCtx));

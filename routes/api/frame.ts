import { defineHandler } from "void";
import { handleFrame } from "../../src/worker/index.ts";

export const GET = defineHandler((c) => handleFrame(c.req.raw, c.env as unknown as Env, c.executionCtx));

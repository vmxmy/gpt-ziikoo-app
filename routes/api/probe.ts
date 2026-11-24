import { defineHandler } from "void";
import { handleProbe } from "../../src/worker/index.ts";

export const POST = defineHandler((c) => handleProbe(c.req.raw, c.env as unknown as Env, c.executionCtx));

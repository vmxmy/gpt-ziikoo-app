import { defineHandler } from "void";
import { handleModels } from "../../src/worker/index.ts";

export const POST = defineHandler((c) => handleModels(c.req.raw, c.env as unknown as Env, c.executionCtx));

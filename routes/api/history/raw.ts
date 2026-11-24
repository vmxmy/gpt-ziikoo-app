import { defineHandler } from "void";
import { handleHistoryRaw } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleHistoryRaw(c.req.raw, c.env as unknown as Env, c.executionCtx));

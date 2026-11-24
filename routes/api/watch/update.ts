import { defineHandler } from "void";
import { handleWatchUpdate } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleWatchUpdate(c.req.raw, c.env as unknown as Env, c.executionCtx));

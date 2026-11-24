import { defineHandler } from "void";
import { handleWatchState } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleWatchState(c.req.raw, c.env as unknown as Env, c.executionCtx));

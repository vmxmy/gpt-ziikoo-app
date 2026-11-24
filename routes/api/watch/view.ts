import { defineHandler } from "void";
import { handleWatchView } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleWatchView(c.req.raw, c.env as unknown as Env, c.executionCtx));

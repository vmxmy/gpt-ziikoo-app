import { defineHandler } from "void";
import { handleWatchCreate } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleWatchCreate(c.req.raw, c.env as unknown as Env, c.executionCtx));

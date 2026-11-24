import { defineHandler } from "void";
import { handleWatchDelete } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleWatchDelete(c.req.raw, c.env as unknown as Env, c.executionCtx));

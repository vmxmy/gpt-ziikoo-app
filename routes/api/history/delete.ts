import { defineHandler } from "void";
import { handleHistoryDelete } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleHistoryDelete(c.req.raw, c.env as unknown as Env, c.executionCtx));

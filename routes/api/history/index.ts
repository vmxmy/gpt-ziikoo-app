import { defineHandler } from "void";
import { handleHistory } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleHistory(c.req.raw, c.env as unknown as Env, c.executionCtx));

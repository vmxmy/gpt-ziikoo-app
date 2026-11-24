import { defineHandler } from "void";
import { handleBoardOrder } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleBoardOrder(c.req.raw, c.env as unknown as Env, c.executionCtx));

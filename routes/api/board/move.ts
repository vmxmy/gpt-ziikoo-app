import { defineHandler } from "void";
import { handleBoardMove } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleBoardMove(c.req.raw, c.env as unknown as Env, c.executionCtx));

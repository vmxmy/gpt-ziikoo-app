import { defineHandler } from "void";
import { handleBoardView } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleBoardView(c.req.raw, c.env as unknown as Env, c.executionCtx));

import { defineHandler } from "void";
import { handleBoardLiveGet, handleBoardLivePost } from "../../../src/worker/index.ts";

export const GET = defineHandler((c) => handleBoardLiveGet(c.req.raw, c.env as unknown as Env, c.executionCtx));
export const POST = defineHandler((c) => handleBoardLivePost(c.req.raw, c.env as unknown as Env, c.executionCtx));

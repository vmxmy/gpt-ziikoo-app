import { defineHandler } from "void";
import { handleBoardAdopt } from "../../../src/worker/index.ts";

export const POST = defineHandler((c) => handleBoardAdopt(c.req.raw, c.env as unknown as Env, c.executionCtx));

import { defineHandler } from "void";
import { handleApiFallback } from "../../src/worker/index.ts";

export default defineHandler((c) => handleApiFallback(c.req.raw));

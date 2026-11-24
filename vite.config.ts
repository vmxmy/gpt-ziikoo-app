import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
	plugins: [preact(), voidPlugin()],
});

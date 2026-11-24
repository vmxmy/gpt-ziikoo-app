import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../void.config.ts?raw";
import headersFile from "../../public/_headers?raw";
import doc from "../../public/api.md?raw";
import { MAX_ATTEMPTS, STAGES } from "../../src/shared/ladder.ts";
import { BOARD_MAX_WATCHES, WATCH_INTERVALS, WATCH_MAX_TOTAL } from "../../src/shared/watch.ts";
import { CONCURRENCY } from "../../src/web/runner.ts";
import { IDLE_MS, MAX_CALLS_PER_RUN, MAX_RUNS } from "../../src/worker/history.ts";
import worker from "../../src/worker/index.ts?raw";
import { DEFAULT_LIMITS, LONG_ANSWER_LIMITS, MAX_BODY_BYTES } from "../../src/worker/probe.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function limiter(name: string): string {
	const match = new RegExp(`name: "${name}".*limit: (\\d+), period: (\\d+)`).exec(config);
	expect(match, name).not.toBeNull();
	return `每 ${match![2]} 秒 ${match![1]} 次`;
}

function listRouteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listRouteFiles(full));
		else if (entry.name.endsWith(".ts") && entry.name !== "[...path].ts") out.push(full);
	}
	return out.sort();
}

function fileToRoutePath(routesApiRoot: string, file: string): string {
	const rel = relative(routesApiRoot, file).replace(/\\/g, "/").replace(/\.ts$/, "");
	return rel.endsWith("/index") ? `/api/${rel.slice(0, -"/index".length)}` : `/api/${rel}`;
}

describe("public/api.md", () => {
	it("lists every route the worker serves", () => {
		const routes = [...worker.matchAll(/"(\/api\/[^"]+)": \{ (GET|POST):/g)].map(([, path, method]) => `| ${method} | \`${path}\` |`);
		expect(routes.length).toBeGreaterThan(0);
		expect(routes.filter((row) => !doc.includes(row))).toEqual([]);
	});

	it("matches routes/api/ file routes with src/worker/index.ts ROUTES", () => {
		const expected = [...worker.matchAll(/"(\/api\/[^"]+)": \{ (GET|POST):/g)]
			.map(([, path, method]) => `${method} ${path}`)
			.sort();
		const routesApiRoot = join(process.cwd(), "routes/api");
		const actual = listRouteFiles(routesApiRoot)
			.flatMap((file) => {
				const src = readFileSync(file, "utf8");
				const path = fileToRoutePath(routesApiRoot, file);
				return [...src.matchAll(/export const (GET|POST)\b/g)].map(([, method]) => `${method} ${path}`);
			})
			.sort();
		expect(actual).toEqual(expected);
	});

	it("keeps /api/* no-store and /api/frame sandbox CSP after /* in public/_headers", () => {
		const rootIdx = headersFile.indexOf("/*");
		const apiIdx = headersFile.indexOf("\n/api/*\n");
		const frameIdx = headersFile.indexOf("\n/api/frame\n");
		expect(rootIdx).toBeGreaterThanOrEqual(0);
		expect(apiIdx).toBeGreaterThan(rootIdx);
		expect(frameIdx).toBeGreaterThan(apiIdx);
		const apiBlock = headersFile.slice(apiIdx, frameIdx);
		const frameBlock = headersFile.slice(frameIdx);
		expect(apiBlock).toContain("Cache-Control: no-store");
		expect(frameBlock).toContain("sandbox allow-scripts");
		expect(frameBlock).toContain("default-src 'none'");
		expect(frameBlock).toContain("Cache-Control: no-store");
	});

	it("states the numbers the code enforces", () => {
		const phrases = [
			`调用数依次是 ${STAGES.map((s) => s.calls).join("、")}`,
			`答对数依次是 ${STAGES.map((s) => s.need).join("、")}`,
			`同时最多 ${CONCURRENCY} 个调用`,
			`最多尝试 ${MAX_ATTEMPTS} 次`,
			`每轮最多 ${MAX_CALLS_PER_RUN} 次调用`,
			`最近 ${MAX_RUNS} 轮`,
			`闲置 ${IDLE_MS / DAY_MS} 天`,
			`${MAX_BODY_BYTES / 1024}KB 与 ${DEFAULT_LIMITS.timeoutMs / 1000} 秒`,
			`${LONG_ANSWER_LIMITS.maxBodyBytes / 1024 / 1024}MB 与 ${LONG_ANSWER_LIMITS.timeoutMs / 1000} 秒`,
			`IP ${limiter("IP_LIMITER")}`,
			`站点${limiter("HOST_LIMITER")}`,
			`间隔是 ${WATCH_INTERVALS.join("、")} 分钟之一`,
			`全站最多 ${WATCH_MAX_TOTAL} 个`,
			`一个看板最多 ${BOARD_MAX_WATCHES} 个`,
		];
		expect(phrases.filter((p) => !doc.includes(p))).toEqual([]);
	});
});

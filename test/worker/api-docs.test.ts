import { describe, expect, it } from "vitest";
import config from "../../cloudflare.config.ts?raw";
import doc from "../../public/api.md?raw";
import { MAX_ATTEMPTS, STAGES } from "../../src/shared/ladder.ts";
import { BOARD_MAX_WATCHES, WATCH_INTERVALS, WATCH_MAX_TOTAL } from "../../src/shared/watch.ts";
import { CONCURRENCY } from "../../src/web/runner.ts";
import { IDLE_MS, MAX_CALLS_PER_RUN, MAX_RUNS } from "../../src/worker/history.ts";
import worker from "../../src/worker/index.ts?raw";
import { DEFAULT_LIMITS, LONG_ANSWER_LIMITS, MAX_BODY_BYTES } from "../../src/worker/probe.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function limiter(name: string): string {
	const match = new RegExp(`${name}: .*limit: (\\d+), period: (\\d+)`).exec(config);
	expect(match, name).not.toBeNull();
	return `每 ${match![2]} 秒 ${match![1]} 次`;
}

describe("public/api.md", () => {
	it("lists every route the worker serves", () => {
		const routes = [...worker.matchAll(/"(\/api\/[^"]+)": \{ (GET|POST):/g)].map(([, path, method]) => `| ${method} | \`${path}\` |`);
		expect(routes.length).toBeGreaterThan(0);
		expect(routes.filter((row) => !doc.includes(row))).toEqual([]);
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

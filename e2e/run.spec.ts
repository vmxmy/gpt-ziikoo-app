import { STAGES } from "../src/shared/ladder.ts";
import { expect, expectOverall, fillForm, scrubbed, startRun, test } from "./fixtures.ts";

// These drive real ladders against the live site. A retry of a serial group reruns every test in
// it, including the full ladders, so retries stay off here to keep the request volume bounded.
test.describe.configure({ mode: "serial", retries: 0, timeout: 360_000 });

// HOST_LIMITER allows 60 probes per minute per target host and every test targets the same mock
// host, so the next test waits out the window after a full ladder (about 62 probes).
const HOST_WINDOW_MS = 60_000;
let quietAt = 0;

test.beforeEach(async () => {
	const wait = quietAt - Date.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
});

const dots = (state: string) => `[data-testid="call-dot"][data-state="${state}"]`;
const settledDots = '[data-testid="call-dot"]:not([data-state="pending"])';

test("mock-good 两题满跑,全部通过,每题 31 次调用", async ({ page, site, key, questions }) =>
	scrubbed(page, async () => {
		await startRun(page, { site, key, model: "mock-good", select: questions.map((q) => q.id), questions });
		await expectOverall(page, "all_passed");
		quietAt = Date.now() + HOST_WINDOW_MS;
		await expect(page.getByTestId("snapshot-notice")).toBeVisible();
		for (const q of questions) {
			await expect(page.getByTestId(`verdict-${q.id}`)).toHaveAttribute("data-status", "passed");
			const lane = page.getByTestId(`lane-${q.id}`);
			await expect(lane.locator(dots("ok"))).toHaveCount(31);
			for (const [i, stage] of STAGES.entries()) {
				await expect(lane.getByTestId(`stage-${i + 1}`).locator(dots("ok"))).toHaveCount(stage.calls);
			}
		}
	}));

// The first stage needs 1 of 1, so a relay that is always wrong is eliminated there.
test("mock-wrong 首关淘汰,早停,显示 failureHint,总评 failed", async ({ page, site, key, questions }) =>
	scrubbed(page, async () => {
		await startRun(page, { site, key, model: "mock-wrong", select: questions.map((q) => q.id), questions });
		await expectOverall(page, "failed");
		for (const q of questions) {
			await expect(page.getByTestId(`verdict-${q.id}`)).toHaveAttribute("data-status", "failed");
			await expect(page.getByTestId(`diagnosis-${q.id}`)).toContainText(q.failureHint);
			const lane = page.getByTestId(`lane-${q.id}`);
			await expect(lane.getByTestId("stage-1").locator(dots("wrong"))).toHaveCount(1);
			for (const n of [2, 3, 4]) await expect(lane.getByTestId(`stage-${n}`).locator(settledDots)).toHaveCount(0);
		}
	}));

test("单选一题,只跑该题", async ({ page, site, key, questions }) =>
	scrubbed(page, async () => {
		const [only, ...others] = questions;
		if (!only) throw new Error("题库为空");
		await fillForm(page, { site, key, model: "mock-wrong", select: questions.map((q) => q.id), questions });
		const allCost = (await page.getByTestId("cost-line").textContent()) ?? "";
		for (const q of others) await page.getByTestId(`question-${q.id}-toggle`).uncheck();
		await expect(page.getByTestId("cost-line")).not.toHaveText(allCost);
		await page.getByTestId("start-button").click();
		await expectOverall(page, "failed");
		await expect(page.getByTestId(`verdict-${only.id}`)).toHaveAttribute("data-status", "failed");
		for (const q of others) {
			await expect(page.getByTestId(`verdict-${q.id}`)).toHaveCount(0);
			await expect(page.locator(`[data-testid="lane-${q.id}"] ${settledDots}`)).toHaveCount(0);
		}
	}));

test("mock-401 总评 unavailable 并显示原因", async ({ page, site, key, questions }) =>
	scrubbed(page, async () => {
		const only = questions[0]!;
		await startRun(page, { site, key, model: "mock-401", select: [only.id], questions });
		await expectOverall(page, "unavailable");
		await expect(page.getByTestId(`verdict-${only.id}`)).toHaveAttribute("data-status", "unavailable");
		const reason = page.locator(`[data-testid="overall-result"], [data-testid="diagnosis-${only.id}"]`).filter({ hasText: "密钥" });
		await expect(reason.first()).toBeVisible();
	}));

test("mock-nostream 回退整块 JSON,明细里 TTFT 为空", async ({ page, site, key, questions }) =>
	scrubbed(page, async () => {
		const only = questions[0]!;
		await startRun(page, { site, key, model: "mock-nostream", select: [only.id], questions });
		await expectOverall(page, "all_passed");
		quietAt = Date.now() + HOST_WINDOW_MS;
		// Located by header text because the contract names the table, not its columns.
		const column = await page.getByTestId(`detail-table-${only.id}`).evaluate((table) => {
			const rows = [...table.querySelectorAll("tr")];
			const header = rows.find((tr) => tr.querySelector("th") && !tr.querySelector("td"));
			const index = header ? [...header.children].findIndex((cell) => /ttft|首字/i.test(cell.textContent ?? "")) : -1;
			const cells = rows.filter((tr) => tr.querySelector("td")).map((tr) => tr.children[index]?.textContent?.trim() ?? null);
			return { index, cells };
		});
		expect(column.index).toBeGreaterThanOrEqual(0);
		expect(column.cells.length).toBeGreaterThan(0);
		for (const cell of column.cells) expect(cell).toMatch(/^[-–—]?$/);
	}));

test("历史:跑完出现一轮,原始数据不含密钥,删除后为空", async ({ page, context, request, site, key, questions }) =>
	scrubbed(page, async () => {
		const only = questions[0]!;
		await startRun(page, { site, key, model: "mock-wrong", select: [only.id], questions });
		await expectOverall(page, "failed");
		const section = page.getByTestId("history-section");
		await expect(section.getByTestId("history-run")).toHaveCount(1, { timeout: 30_000 });
		const download = page.waitForEvent("download");
		await section.getByTestId("history-raw-button").first().click();
		// Opened in the browser because the specs compile without Node types.
		const viewer = await context.newPage();
		await viewer.goto(`file://${await (await download).path()}`);
		const rawText = (await viewer.locator("pre").first().textContent()) ?? "";
		await viewer.close();
		expect(rawText).toContain(only.id);
		expect(rawText).not.toContain(key);
		await section.getByTestId("history-delete-button").click();
		await expect(section.getByTestId("history-empty")).toBeVisible();
		await expect(section.getByTestId("history-run")).toHaveCount(0);
		expect(await (await request.post("/api/history", { data: { site, key } })).json()).toEqual({ runs: [] });
	}));

import type { APIRequestContext, Page } from "@playwright/test";
import { STAGES } from "../src/shared/ladder.ts";
import type { HistoryResponse, OverallStatus, QuestionListItem } from "../src/shared/types.ts";
import { expect, expectOverall, fillForm, RUN_TIMEOUT_MS, type RunSetup, scrubbed, startRun, test } from "./fixtures.ts";

// These drive real ladders against the live site. A retry of a serial group reruns every test in
// it, including the full ladders, so retries stay off here to keep the request volume bounded.
test.describe.configure({ mode: "serial", retries: 0, timeout: 360_000 });

// HOST_LIMITER allows 60 probes per minute per target host and every probe targets the same mock
// host. A full ladder is 32 probes (31 plus the stage-1 race), at most 33 with one question
// eliminated alongside it, so only one passing question runs per ladder. Full ladders are spaced
// a window apart. api.spec runs first (workers: 1) and its 20 probes can only share a window with
// the first 32-probe ladder; the light tests between mock-partial and mock-nostream add at most 18
// (4 + 2 + 6 + 6) and the history test 2, so any 60-second window stays at or below 52.
const HOST_WINDOW_MS = 60_000;
let quietAt = 0;

async function fullLadder(page: Page, setup: RunSetup, status: OverallStatus): Promise<void> {
	const wait = quietAt - Date.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	try {
		await startRun(page, setup);
		await expectOverall(page, status);
	} finally {
		quietAt = Date.now() + HOST_WINDOW_MS;
	}
}

const dots = (state: string) => `[data-testid="call-dot"][data-state="${state}"]`;
const settledDots = '[data-testid="call-dot"]:not([data-state="pending"])';

// docs/design.md「架构」: stage 1 of the first question races both channels once, so that stage
// holds one dot per channel. Every other stage and question runs on the chosen channel only.
function stageDots(questions: QuestionListItem[], select: string[], id: string, index: number): number {
	const first = questions.find((q) => select.includes(q.id));
	return (index === 0 && first?.id === id ? 1 : 0) + STAGES[index]!.calls;
}

async function expectFullLane(page: Page, questions: QuestionListItem[], select: string[], id: string): Promise<void> {
	const lane = page.getByTestId(`lane-${id}`);
	for (const index of STAGES.keys()) {
		await expect(lane.getByTestId(`stage-${index + 1}`).locator(dots("ok"))).toHaveCount(stageDots(questions, select, id, index));
	}
}

async function history(request: APIRequestContext, site: string, key: string): Promise<HistoryResponse> {
	return (await request.post("/api/history", { data: { site, key } })).json();
}

// The worker recomputes each verdict from the stored calls with the shared ladder functions, so a
// page that records the stage-1 race differently from what the worker expects shows up here.
async function expectHistoryMatchesPage(page: Page, request: APIRequestContext, site: string, key: string, select: string[]) {
	const overall = await page.getByTestId("overall-result").getAttribute("data-status");
	const questions = await Promise.all(
		select.map(async (id) => {
			const status = await page.getByTestId(`verdict-${id}`).getAttribute("data-status");
			return expect.objectContaining({ id, verdict: expect.objectContaining({ status }) });
		}),
	);
	// The last call is persisted after its reply, so the newest run can briefly read as incomplete.
	await expect.poll(async () => (await history(request, site, key)).runs[0]).toMatchObject({ overall, questions: expect.arrayContaining(questions) });
}

async function expectEliminated(page: Page, questions: QuestionListItem[], select: string[], id: string): Promise<void> {
	const lane = page.getByTestId(`lane-${id}`);
	await expect(lane.getByTestId("stage-1").locator(dots("wrong"))).toHaveCount(stageDots(questions, select, id, 0));
	for (const n of [2, 3, 4]) await expect(lane.getByTestId(`stage-${n}`).locator(settledDots)).toHaveCount(0);
}

test("mock-good 每题单独满跑,全部通过,每关调用数符合梯度", async ({ page, request, site, key, questions }) => {
	test.setTimeout(questions.length * (HOST_WINDOW_MS + RUN_TIMEOUT_MS));
	await scrubbed(page, async () => {
		for (const q of questions) {
			const select = [q.id];
			await fullLadder(page, { site, key, model: "mock-good", select, questions }, "all_passed");
			await expect(page.getByTestId("snapshot-notice")).toBeVisible();
			await expect(page.getByTestId(`verdict-${q.id}`)).toHaveAttribute("data-status", "passed");
			await expectFullLane(page, questions, select, q.id);
			await expectHistoryMatchesPage(page, request, site, key, select);
		}
	});
});

test("mock-partial 一题通过一题首关淘汰,总评 partial", async ({ page, request, site, key, questions }) =>
	scrubbed(page, async () => {
		const select = ["thibault", "candy"];
		await fullLadder(page, { site, key, model: "mock-partial", select, questions }, "partial");
		await expect(page.getByTestId("verdict-thibault")).toHaveAttribute("data-status", "passed");
		await expect(page.getByTestId("verdict-candy")).toHaveAttribute("data-status", "failed");
		await expectFullLane(page, questions, select, "thibault");
		await expectEliminated(page, questions, select, "candy");
		await expectHistoryMatchesPage(page, request, site, key, select);
		// "部分通过" is no question's label, so the history row can only match it through its overall
		// label. The contract names the overall element, not its label, so it is read off the page.
		const label = /：\s*([^（(\s]+)/.exec((await page.getByTestId("overall-result").textContent()) ?? "")?.[1];
		expect(label).toBeTruthy();
		await loadHistory(page);
		await expect(page.getByTestId("history-section").getByTestId("history-run")).toContainText(label ?? "");
	}));

// The first stage needs 1 of 1, so a relay that is always wrong is eliminated there.
test("mock-wrong 首关淘汰,早停,显示 failureHint,总评 failed", async ({ page, request, site, key, questions }) =>
	scrubbed(page, async () => {
		const select = questions.map((q) => q.id);
		await startRun(page, { site, key, model: "mock-wrong", select, questions });
		await expectOverall(page, "failed");
		for (const q of questions) {
			await expect(page.getByTestId(`verdict-${q.id}`)).toHaveAttribute("data-status", "failed");
			await expect(page.getByTestId(`diagnosis-${q.id}`)).toContainText(q.failureHint);
			await expectEliminated(page, questions, select, q.id);
			// AGENTS.md: relay answers are untrusted and rendered as text nodes only.
			await expect(page.getByTestId(`detail-table-${q.id}`).locator("b, img")).toHaveCount(0);
		}
		await expect(page.getByTestId("detail-table-thibault")).toContainText("<b>bold</b>");
		await expectHistoryMatchesPage(page, request, site, key, select);
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

test("mock-429 总评 unavailable 并提示站点限流", async ({ page, site, key, questions }) =>
	scrubbed(page, async () => {
		const only = questions[0]!;
		await startRun(page, { site, key, model: "mock-429", select: [only.id], questions });
		await expectOverall(page, "unavailable");
		await expect(page.getByTestId(`verdict-${only.id}`)).toHaveAttribute("data-status", "unavailable");
		const reason = page
			.locator(`[data-testid="overall-result"], [data-testid="diagnosis-${only.id}"]`)
			.filter({ hasText: /限流|站点正忙/ });
		await expect(reason.first()).toBeVisible();
	}));

test("mock-nostream 回退整块 JSON,明细里 TTFT 为空", async ({ page, site, key, questions }) =>
	scrubbed(page, async () => {
		const only = questions[0]!;
		await fullLadder(page, { site, key, model: "mock-nostream", select: [only.id], questions }, "all_passed");
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

// The page only fetches history on demand. The call is persisted after the probe reply, so the
// load is retried until the run shows up.
async function loadHistory(page: Page): Promise<void> {
	const section = page.getByTestId("history-section");
	await expect(async () => {
		await section.getByRole("button", { name: "查看历史" }).click();
		await expect(section.getByTestId("history-run")).toHaveCount(1, { timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
}

test("历史:跑完可取回一轮,重载后仍在,原始数据不含密钥,删除后为空", async ({ page, context, request, site, key, questions }) =>
	scrubbed(page, async () => {
		const only = questions[0]!;
		const setup = { site, key, model: "mock-wrong", select: [only.id], questions };
		await startRun(page, setup);
		await expectOverall(page, "failed");
		await loadHistory(page);
		// A reload drops page memory, so a run seen afterwards came from the server.
		await fillForm(page, setup);
		await loadHistory(page);
		const section = page.getByTestId("history-section");
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

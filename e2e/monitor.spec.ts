import type { Page } from "@playwright/test";
import { MONITOR } from "../src/shared/monitor.ts";
import { expect, test } from "./fixtures.ts";

test.describe.configure({ mode: "serial", retries: 0 });

const BOARD_KEY = "gpt.board.v1";
const TOKENS_KEY = "gpt.watch.v1";
const LEGACY_KEY = "gpt.monitors.v1";
const CARDS = '[data-testid^="custom-"][data-testid$="-card"]';

type AddSetup = {
	site: string;
	key: string;
	alias?: string;
	model?: string;
	protocol?: "responses" | "chat";
	intervalMin?: 5 | 15;
	questions?: string[];
	consent?: boolean;
};

const QUESTION_PICK = "watch-add-question-";

async function addWatch(page: Page, { site, key, alias, model = "mock-good", protocol, intervalMin, questions, consent = true }: AddSetup): Promise<void> {
	await page.getByTestId("watch-add-toggle").click();
	await page.getByTestId("watch-add-site").fill(site);
	if (alias) await page.getByTestId("watch-add-alias").fill(alias);
	await page.getByTestId("watch-add-key").fill(key);
	await page.getByTestId("watch-add-model").fill(model);
	if (protocol) await page.getByTestId("watch-add-protocol").selectOption(protocol);
	if (intervalMin) await page.getByTestId("watch-add-interval").selectOption(String(intervalMin));
	if (questions) {
		const picks = page.locator(`[data-testid^="${QUESTION_PICK}"]`);
		await expect(picks.first()).toBeVisible();
		for (const pick of await picks.all()) {
			const id = (await pick.getAttribute("data-testid"))?.slice(QUESTION_PICK.length) ?? "";
			await pick.setChecked(questions.includes(id));
		}
	}
	await page.getByTestId("watch-add-consent").setChecked(consent);
	await page.getByTestId("watch-add-submit").click();
}

async function lastCardId(page: Page): Promise<string> {
	const testId = (await page.locator(CARDS).last().getAttribute("data-testid")) ?? "";
	const id = /^custom-([A-Za-z0-9_-]{8})-card$/.exec(testId)?.[1];
	expect(id, `card test id ${testId}`).toBeTruthy();
	return id!;
}

const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }));

async function cleaned(page: Page, body: () => Promise<void>): Promise<void> {
	try {
		await body();
	} finally {
		await page.locator('input[type="password"], [data-testid="watch-add-key"]').evaluateAll((inputs) => {
			for (const input of inputs) if (input instanceof HTMLInputElement) input.value = "";
		});
		const board: string | null = await page.evaluate((k) => localStorage.getItem(k), BOARD_KEY);
		if (board) {
			const res = await page.request.post("/api/board/view", { data: { board } });
			if (res.ok()) {
				const body: { watches: { token: string }[] } = await res.json();
				for (const { token } of body.watches) {
					await page.request.post("/api/watch/delete", { data: { token } });
				}
			}
		}
		await page.evaluate((keys) => {
			for (const k of keys) localStorage.removeItem(k);
		}, [BOARD_KEY, TOKENS_KEY, LEGACY_KEY]);
	}
}

async function openWatchTab(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByTestId("tab-watch").click();
}

async function addOneGood(page: Page, site: string, key: string): Promise<string> {
	await openWatchTab(page);
	await addWatch(page, { site, key });
	await expect(page.locator(CARDS)).toHaveCount(1);
	const id = await lastCardId(page);
	await expect(page.getByTestId(`custom-${id}-badge`)).toHaveAttribute("data-state", "insufficient", { timeout: 30_000 });
	return id;
}

test("切换到持续监测 tab,添加后立即返回首个样本,密钥不进本地存储与页面", async ({ page, site, key }) =>
	cleaned(page, async () => {
		const id = await addOneGood(page, site, key);
		await expect(page.getByTestId(`custom-${id}-segment`)).toHaveCount(MONITOR.buckets);
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), BOARD_KEY)).toBeTruthy();
		expect(await stored(page)).not.toContain(key);
		expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(key);
	}));

test("刷新后卡片仍在,服务器继续监测", async ({ page, site, key }) =>
	cleaned(page, async () => {
		const id = await addOneGood(page, site, key);
		await page.reload();
		// The hash stays on #watch across a reload, so the tab itself restores.
		await expect(page.getByTestId(`custom-${id}-card`)).toBeVisible();
		await expect(page.getByTestId(`custom-${id}-uptime`)).not.toHaveText("—");
	}));

test("暂停与继续", async ({ page, site, key }) =>
	cleaned(page, async () => {
		const id = await addOneGood(page, site, key);
		await page.getByTestId(`custom-${id}-pause`).click();
		await expect(page.getByTestId(`custom-${id}-notice`)).toHaveText("已暂停");
		await page.getByTestId(`custom-${id}-resume`).click();
		await expect(page.getByTestId(`custom-${id}-notice`)).toHaveCount(0);
		await expect(page.getByTestId(`custom-${id}-pause`)).toBeVisible();
	}));

test("删除,服务器与本地令牌都清空", async ({ page, site, key }) =>
	cleaned(page, async () => {
		const id = await addOneGood(page, site, key);
		await page.getByTestId(`custom-${id}-remove`).click();
		await expect(page.locator(CARDS)).toHaveCount(0);
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), BOARD_KEY)).toBeTruthy();
	}));

test("别名区分同一站点的两张卡片", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await openWatchTab(page);
		await addWatch(page, { site, key, alias: "主通道" });
		await expect(page.locator(CARDS)).toHaveCount(1);
		await addWatch(page, { site, key });
		await expect(page.locator(CARDS)).toHaveCount(2);
		const [first, second] = await page.locator(CARDS).all();
		await expect(first!.locator(".card-alias")).toHaveText("主通道");
		await expect(second!.locator(".card-alias")).toHaveCount(0);
	}));

test("置顶后顺序保持到刷新", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await openWatchTab(page);
		await addWatch(page, { site, key, alias: "主通道" });
		await expect(page.locator(CARDS)).toHaveCount(1);
		await addWatch(page, { site, key });
		await expect(page.locator(CARDS)).toHaveCount(2);
		const second = await lastCardId(page);
		await page.getByTestId(`custom-${second}-top`).click();
		await expect(page.locator(CARDS).first()).toHaveAttribute("data-testid", `custom-${second}-card`);
		await page.reload();
		await expect(page.locator(CARDS).first()).toHaveAttribute("data-testid", `custom-${second}-card`, { timeout: 30_000 });
	}));

test("未勾选同意:提示且不建卡片", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await openWatchTab(page);
		await addWatch(page, { site, key, consent: false });
		await expect(page.getByTestId("watch-add-error")).toContainText("同意");
		await expect(page.locator(CARDS)).toHaveCount(0);
	}));

test("无效密钥:字段报错且不建卡片", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await openWatchTab(page);
		await addWatch(page, { site, key, model: "mock-401" });
		await expect(page.getByTestId("watch-add-error")).toContainText("密钥");
		await expect(page.locator(CARDS)).toHaveCount(0);
	}));

test("站点必须是 https,显示字段级错误", async ({ page, key }) =>
	cleaned(page, async () => {
		await openWatchTab(page);
		await addWatch(page, { site: "http://example.com", key });
		await expect(page.getByTestId("watch-add-error")).toHaveText("只支持 https 地址");
		await expect(page.getByTestId("watch-add-site")).toHaveAttribute("aria-invalid", "true");
		await expect(page.locator(CARDS)).toHaveCount(0);
	}));

test("chat 协议与 15 分钟间隔也能添加", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await openWatchTab(page);
		await addWatch(page, { site, key, protocol: "chat", intervalMin: 15 });
		await expect(page.locator(CARDS)).toHaveCount(1);
		const id = await lastCardId(page);
		await expect(page.getByTestId(`custom-${id}-badge`)).toHaveAttribute("data-state", "insufficient", { timeout: 30_000 });
		await expect(page.getByTestId(`custom-${id}-card`)).toContainText("协议 chat");
	}));

test("只选一道题,卡片只列这道题;一道不选时提示且不建卡片", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await openWatchTab(page);
		await addWatch(page, { site, key, questions: [] });
		await expect(page.getByTestId("watch-add-error")).toHaveText("请至少选一道题");
		await expect(page.locator(CARDS)).toHaveCount(0);
		await page.getByTestId(`${QUESTION_PICK}ciallo`).check();
		await page.getByTestId("watch-add-submit").click();
		await expect(page.locator(CARDS)).toHaveCount(1);
		const id = await lastCardId(page);
		await expect(page.getByTestId(`custom-${id}-badge`)).toHaveAttribute("data-state", "insufficient", { timeout: 30_000 });
		await expect(page.getByTestId(`custom-${id}-card`)).toContainText("题目 ciallo · ");
	}));

test("旧的浏览器监测存储被清除", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await page.goto("/");
		await page.evaluate((k) => localStorage.setItem(k, '{"sites":[]}'), LEGACY_KEY);
		await page.getByTestId("tab-watch").click();
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBe(null);
	}));

test("看板链接在新设备载入全部面板", async ({ page, site, key, context }) =>
	cleaned(page, async () => {
		const id = await addOneGood(page, site, key);
		const link = await page.getByTestId("watch-share-toggle").click().then(() => page.getByTestId("watch-share-link").inputValue());
		const newPage = await context.newPage();
		await newPage.goto(link);
		await expect(newPage.locator(`[data-testid="custom-${id}-card"]`)).toBeVisible({ timeout: 30_000 });
		await expect(newPage).toHaveURL(/#watch$/);
		await newPage.close();
	}));

test("重置后旧链接失效", async ({ page, site, key, context }) =>
	cleaned(page, async () => {
		await addOneGood(page, site, key);
		await page.getByTestId("watch-share-toggle").click();
		const oldLink = await page.getByTestId("watch-share-link").inputValue();
		await page.getByTestId("watch-share-reset").click();
		const newPage = await context.newPage();
		await newPage.goto(oldLink);
		await expect(newPage.getByTestId("watch-board-notice")).toContainText("看板不存在或已过期");
		await newPage.close();
	}));

test("旧版令牌存储迁移到看板", async ({ page, site, key }) =>
	cleaned(page, async () => {
		// localStorage is only reachable on the site's origin; about:blank throws a SecurityError.
		await page.goto("/");
		const res = await page.request.post("/api/watch", {
			data: { site, key, model: "mock-good", protocol: "responses", intervalMin: 5, alias: "", consent: true },
		});
		expect(res.ok()).toBe(true);
		const { token } = await res.json();
		await page.evaluate((args) => localStorage.setItem(args.key, JSON.stringify([args.token])), { key: TOKENS_KEY, token });
		await page.goto("/");
		await page.getByTestId("tab-watch").click();
		await expect(page.locator(CARDS)).toHaveCount(1, { timeout: 30_000 });
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), TOKENS_KEY)).toBe(null);
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), BOARD_KEY)).toBeTruthy();
	}));

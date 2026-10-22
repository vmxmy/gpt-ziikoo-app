import type { Page } from "@playwright/test";
import { MONITOR } from "../src/shared/monitor.ts";
import { expect, test } from "./fixtures.ts";

// Every add probes the shared mock host once, and each card re-reads once a minute. Serial tests keep
// those calls from bunching up next to run.spec's ladders.
test.describe.configure({ mode: "serial", retries: 0 });

const TOKENS_KEY = "gpt.watch.v1";
const LEGACY_KEY = "gpt.monitors.v1";
const CARDS = '[data-testid^="custom-"][data-testid$="-card"]';

type AddSetup = { site: string; key: string; alias?: string; model?: string; protocol?: "responses" | "chat"; intervalMin?: 5 | 15; consent?: boolean };

async function addWatch(page: Page, { site, key, alias, model = "mock-good", protocol, intervalMin, consent = true }: AddSetup): Promise<void> {
	await page.getByTestId("watch-add-toggle").click();
	await page.getByTestId("watch-add-site").fill(site);
	if (alias) await page.getByTestId("watch-add-alias").fill(alias);
	await page.getByTestId("watch-add-key").fill(key);
	await page.getByTestId("watch-add-model").fill(model);
	if (protocol) await page.getByTestId("watch-add-protocol").selectOption(protocol);
	if (intervalMin) await page.getByTestId("watch-add-interval").selectOption(String(intervalMin));
	if (!consent) await page.getByTestId("watch-add-consent").uncheck();
	await page.getByTestId("watch-add-submit").click();
}

async function lastCardId(page: Page): Promise<string> {
	const testId = (await page.locator(CARDS).last().getAttribute("data-testid")) ?? "";
	const id = /^custom-([A-Za-z0-9_-]{8})-card$/.exec(testId)?.[1];
	expect(id, `card test id ${testId}`).toBeTruthy();
	return id!;
}

const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }));

// Keys typed into the page must not survive into a failure screenshot or trace, and the watches must
// not outlive the test on the server or in this origin's storage.
async function cleaned(page: Page, body: () => Promise<void>): Promise<void> {
	try {
		await body();
	} finally {
		await page.locator('input[type="password"], [data-testid="watch-add-key"]').evaluateAll((inputs) => {
			for (const input of inputs) if (input instanceof HTMLInputElement) input.value = "";
		});
		const tokens: string[] = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "[]"), TOKENS_KEY);
		for (const token of tokens) {
			const res = await page.request.post("/api/watch/delete", { data: { token } });
			expect(res.status()).toBe(200);
		}
		await page.evaluate((keys) => {
			for (const k of keys) localStorage.removeItem(k);
		}, [TOKENS_KEY, LEGACY_KEY]);
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
		await expect.poll(() => stored(page)).toContain(id);
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
		const token = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "[]")[0], TOKENS_KEY);
		await page.getByTestId(`custom-${id}-remove`).click();
		await expect(page.locator(CARDS)).toHaveCount(0);
		await expect.poll(() => stored(page)).not.toContain(token);
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

test("旧的浏览器监测存储被清除", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await page.goto("/");
		await page.evaluate((k) => localStorage.setItem(k, '{"sites":[]}'), LEGACY_KEY);
		await page.getByTestId("tab-watch").click();
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBe(null);
	}));

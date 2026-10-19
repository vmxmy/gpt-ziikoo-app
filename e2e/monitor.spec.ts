import type { Page } from "@playwright/test";
import { MONITOR } from "../src/shared/monitor.ts";
import { expect, test } from "./fixtures.ts";

// Every add probes the shared mock host once, and an open card probes again each minute. Serial
// tests keep those calls from bunching up next to run.spec's ladders.
test.describe.configure({ mode: "serial", retries: 0 });

const STORAGE_KEY = "gpt.monitors.v1";
const CARDS = '[data-testid^="custom-"][data-testid$="-card"]';

type AddSetup = { site: string; key: string; alias?: string; model?: string; protocol?: "responses" | "chat" };

async function addSite(page: Page, { site, key, alias, model = "mock-good", protocol }: AddSetup): Promise<void> {
	await page.getByTestId("monitor-add-toggle").click();
	await page.getByTestId("monitor-add-site").fill(site);
	if (alias) await page.getByTestId("monitor-add-alias").fill(alias);
	await page.getByTestId("monitor-add-key").fill(key);
	await page.getByTestId("monitor-add-model").fill(model);
	if (protocol) await page.getByTestId("monitor-add-protocol").selectOption(protocol);
	await page.getByTestId("monitor-add-submit").click();
}

async function lastCardId(page: Page): Promise<string> {
	const testId = (await page.locator(CARDS).last().getAttribute("data-testid")) ?? "";
	const id = /^custom-([0-9a-f]{8})-card$/.exec(testId)?.[1];
	expect(id, `card test id ${testId}`).toBeTruthy();
	return id!;
}

const stored = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }));

// Keys typed into the page must not survive into a failure screenshot or trace, and the cards must
// not outlive the test in this origin's storage.
async function cleaned(page: Page, body: () => Promise<void>): Promise<void> {
	try {
		await body();
	} finally {
		await page.locator('input[type="password"], [data-testid="monitor-add-key"]').evaluateAll((inputs) => {
			for (const input of inputs) if (input instanceof HTMLInputElement) input.value = "";
		});
		await page.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY);
	}
}

async function addOneGood(page: Page, site: string, key: string): Promise<string> {
	await page.goto("/");
	await addSite(page, { site, key });
	await expect(page.locator(CARDS)).toHaveCount(1);
	const id = await lastCardId(page);
	await expect(page.getByTestId(`custom-${id}-badge`)).toHaveAttribute("data-state", "insufficient", { timeout: 30_000 });
	return id;
}

test("添加自定义站点后立即探测,密钥不进本地存储与页面", async ({ page, site, key }) =>
	cleaned(page, async () => {
		const id = await addOneGood(page, site, key);
		await expect(page.getByTestId(`custom-${id}-segment`)).toHaveCount(MONITOR.buckets);
		await expect.poll(() => stored(page)).toContain(id);
		expect(await stored(page)).not.toContain(key);
		expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(key);
	}));

test("刷新后保留样本并要求重新输入密钥,输入后继续", async ({ page, site, key }) =>
	cleaned(page, async () => {
		const id = await addOneGood(page, site, key);
		await page.reload();
		await expect(page.getByTestId(`custom-${id}-card`)).toBeVisible();
		await expect(page.getByTestId(`custom-${id}-uptime`)).not.toHaveText("—");
		await expect(page.getByTestId(`custom-${id}-notice`)).toContainText("需要重新输入密钥");
		await expect(page.getByTestId(`custom-${id}-key`)).toHaveAttribute("autocomplete", "current-password");
		await expect(page.getByTestId(`custom-${id}-card`).locator('input[autocomplete="username"]')).toHaveCount(1);
		await page.getByTestId(`custom-${id}-key`).fill(key);
		await page.getByTestId(`custom-${id}-resume`).click();
		await expect(page.getByTestId(`custom-${id}-key`)).toHaveCount(0);
		await expect(page.getByTestId(`custom-${id}-notice`)).toHaveCount(0);
		await expect(page.getByTestId(`custom-${id}-pause`)).toBeVisible();
	}));

test("暂停与删除,删除后本地数据清除", async ({ page, site, key }) =>
	cleaned(page, async () => {
		const id = await addOneGood(page, site, key);
		await page.getByTestId(`custom-${id}-pause`).click();
		await expect(page.getByTestId(`custom-${id}-notice`)).toHaveText("已暂停");
		await page.getByTestId(`custom-${id}-remove`).click();
		await expect(page.locator(CARDS)).toHaveCount(0);
		await expect.poll(() => stored(page)).not.toContain(id);
	}));

test("别名区分同一站点的两张卡片,可留空,刷新后保留", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await page.goto("/");
		await addSite(page, { site, key, alias: "主通道" });
		await expect(page.locator(CARDS)).toHaveCount(1);
		await addSite(page, { site, key });
		await expect(page.locator(CARDS)).toHaveCount(2);
		const [first, second] = await page.locator(CARDS).all();
		await expect(first!.locator(".card-alias")).toHaveText("主通道");
		await expect(second!.locator(".card-alias")).toHaveCount(0);
		await page.reload();
		await expect(page.locator(CARDS)).toHaveCount(2);
		await expect(page.locator(`${CARDS} .card-alias`)).toHaveText(["主通道"]);
		expect(await stored(page)).toContain("主通道");
	}));

test("无效密钥:提示密钥无效且不建卡片", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await page.goto("/");
		await addSite(page, { site, key, model: "mock-401" });
		await expect(page.getByTestId("monitor-add-error")).toContainText("密钥无效");
		await expect(page.locator(CARDS)).toHaveCount(0);
	}));

test("站点必须是 https,显示字段级错误", async ({ page, key }) =>
	cleaned(page, async () => {
		await page.goto("/");
		await addSite(page, { site: "http://example.com", key });
		await expect(page.getByTestId("monitor-add-error")).toHaveText("只支持 https 地址");
		await expect(page.getByTestId("monitor-add-site")).toHaveAttribute("aria-invalid", "true");
		await expect(page.locator(CARDS)).toHaveCount(0);
	}));

test("最多 6 张自定义卡片", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await page.goto("/");
		for (let n = 1; n <= 6; n++) {
			await addSite(page, { site, key });
			await expect(page.locator(CARDS)).toHaveCount(n);
		}
		await expect(page.getByTestId("monitor-add-toggle")).toBeDisabled();
		await expect(page.getByTestId("monitor-add-card")).toHaveCount(0);
		await expect(page.getByText("最多 6 个自定义站点")).toBeVisible();
		const remove = page.locator('[data-testid^="custom-"][data-testid$="-remove"]');
		for (let n = 6; n > 0; n--) {
			await remove.first().click();
			await expect(page.locator(CARDS)).toHaveCount(n - 1);
		}
		await expect.poll(() => stored(page)).not.toContain(new URL(site).host);
	}));

test("chat 通道也能添加并探测成功", async ({ page, site, key }) =>
	cleaned(page, async () => {
		await page.goto("/");
		await addSite(page, { site, key, protocol: "chat" });
		await expect(page.locator(CARDS)).toHaveCount(1);
		const id = await lastCardId(page);
		await expect(page.getByTestId(`custom-${id}-badge`)).toHaveAttribute("data-state", "insufficient", { timeout: 30_000 });
		await expect(page.getByTestId(`custom-${id}-card`)).toContainText("协议 chat");
	}));

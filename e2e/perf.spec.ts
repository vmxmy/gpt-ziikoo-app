import { expect, test } from "./fixtures.ts";

const RUN_MS = 150_000;

test("性能测试按 1 × 30 发压后列出五项达标，页面与下载的报告都不含密钥", async ({ page, context, site, key }) => {
	test.setTimeout(RUN_MS + 30_000);
	try {
		await page.goto("/#perf");
		await page.getByTestId("perf-site").fill(site);
		await page.getByTestId("perf-key").fill(key);
		await page.getByTestId("perf-model").fill("mock-measure");
		await expect(page.getByTestId("perf-qps")).toHaveValue("1");
		await expect(page.getByTestId("perf-duration")).toHaveValue("30");
		await expect(page.getByTestId("perf-cost")).toContainText("本次调用 31 次");
		await page.getByTestId("perf-run").click();
		await expect(page.getByTestId("perf-counts")).toBeVisible();
		await page.getByTestId("tab-live").click();
		await page.getByTestId("tab-perf").click();
		await expect(page.getByTestId("perf-result")).toBeVisible({ timeout: RUN_MS });
		await expect(page.getByTestId("perf-criteria").locator("tbody tr")).toHaveCount(5);
		await expect(page.getByTestId("perf-details")).toContainText("调用数");
		await expect(page.getByTestId("perf-conditions")).toContainText("1 × 30 秒");
		expect(await page.content()).not.toContain(key);
		expect(await page.locator("body").innerText()).not.toContain(key);

		const pending = page.waitForEvent("download");
		await page.getByTestId("perf-download").click();
		const download = await pending;
		expect(download.suggestedFilename()).toMatch(/_mock-measure_qps_bench\.html$/);
		// Opened in the browser because the specs compile without Node types.
		const viewer = await context.newPage();
		await viewer.goto(`file://${await download.path()}`);
		const report = await viewer.content();
		await viewer.close();
		expect(report).toContain("五项达标");
		expect(report).not.toContain(key);
	} finally {
		await page.locator('[data-testid="perf-key"]').evaluateAll((inputs) => {
			for (const input of inputs) if (input instanceof HTMLInputElement) input.value = "";
		});
	}
});

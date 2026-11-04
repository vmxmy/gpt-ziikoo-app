import { expect, test } from "./fixtures.ts";

test("Claude 专项依次执行 13 个用例，切换页签后保留结果，页面与报告不含密钥", async ({ page, context, site, key }) => {
	test.setTimeout(240_000);
	const sent: string[] = [];
	const pending = new Set<string>();
	let maxPending = 0;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname !== "/api/claude-case") return;
		const id: string = request.postDataJSON().case;
		sent.push(id);
		pending.add(id);
		maxPending = Math.max(maxPending, pending.size);
	});
	page.on("response", (response) => {
		if (new URL(response.url()).pathname === "/api/claude-case") pending.delete(response.request().postDataJSON().case);
	});
	try {
		await page.goto("/#claude");
		await expect(page.getByTestId("tab-claude")).toHaveAttribute("aria-selected", "true");
		await page.getByTestId("claude-site").fill(site);
		await page.getByTestId("claude-key").fill(key);
		await page.getByTestId("claude-model").fill("mock-claude");
		await page.getByTestId("claude-run").click();
		await page.getByTestId("tab-live").click();
		await page.getByTestId("tab-claude").click();
		await expect(page.getByTestId("claude-result")).toBeVisible({ timeout: 210_000 });
		await expect(page.getByTestId("claude-matrix").locator("tbody tr")).toHaveCount(13);
		for (const id of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "P1", "P2", "P3"]) {
			await expect(page.getByTestId(`claude-verdict-${id}`)).toHaveText(/^(通过|未通过|协议缺口|未测)$/);
		}
		await expect(page.getByTestId("claude-verdict-P3")).toHaveText("未测");
		expect(sent).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "P1", "P2", "P3"]);
		expect(maxPending).toBe(1);
		expect(await page.content()).not.toContain(key);
		expect(await page.locator("body").innerText()).not.toContain(key);
		const downloading = page.waitForEvent("download");
		await page.getByTestId("claude-download").click();
		const download = await downloading;
		expect(download.suggestedFilename()).toMatch(/_mock-claude_claude_protocol\.html$/);
		const viewer = await context.newPage();
		await viewer.goto(`file://${await download.path()}`);
		expect(await viewer.locator("h2").allTextContents()).toEqual(["测试条件", "结论", "用例矩阵", "不通过清单", "来源判断", "Request ID", "原始数据"]);
		expect(await viewer.content()).not.toContain(key);
		await expect(viewer.locator("body")).toContainText("本站不保存原始数据");
		await viewer.close();
	} finally {
		await page.getByTestId("claude-key").evaluateAll((inputs) => {
			for (const input of inputs) if (input instanceof HTMLInputElement) input.value = "";
		});
	}
});

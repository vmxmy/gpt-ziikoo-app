import { expect, test } from "./fixtures.ts";

test("折扣核算页签默认显示 31%，换模型后数字变化，且隐藏站点与密钥面板", async ({ page }) => {
	await page.goto("/#cost");
	await expect(page.getByTestId("cost-ratio")).toHaveText("31%");
	await expect(page.getByTestId("cost-hit-factor")).toHaveText("×3.12");
	await expect(page.getByTestId("site-input")).toBeHidden();
	await expect(page.getByTestId("key-input")).toBeHidden();
	await page.getByTestId("cost-model-astra").check();
	await expect(page.getByTestId("cost-ratio")).toHaveText("19%");
	await page.getByTestId("cost-model-opus55").check();
	await expect(page.getByTestId("cost-ratio")).toHaveText("26%");
	await expect(page.getByTestId("cost-model-prices")).toContainText("25 倍");
	await expect(page.getByTestId("cost-model-prices")).toContainText("5 分钟缓存写入价");
});

import { expect, test } from "./fixtures.ts";

test("页面加载,题目清单,题面展开与复制和接口逐字节一致", async ({ page, context, questions }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/");
	for (const id of ["site-input", "key-input", "model-input", "start-button", "cost-line"]) {
		await expect(page.getByTestId(id)).toBeVisible();
	}
	await expect(page.getByTestId("api-docs")).toBeAttached();
	expect(questions.length).toBeGreaterThan(0);
	for (const q of questions) {
		await expect(page.getByTestId(`question-${q.id}`)).toBeVisible();
		const generated = q.generator !== undefined;
		await expect(page.getByTestId(`question-${q.id}`).getByText("每轮随机生成")).toHaveCount(generated ? 1 : 0);
		await expect(page.getByTestId(`question-${q.id}-prompt-toggle`)).toHaveText(generated ? "查看示例题面" : "查看题面");
		await page.getByTestId(`question-${q.id}-prompt-toggle`).click();
		const prompt = page.getByTestId(`question-${q.id}-prompt`);
		await expect(prompt).toBeVisible();
		expect(await prompt.textContent()).toBe(q.prompt);
		await page.getByTestId(`question-${q.id}-copy`).click();
		await expect(page.getByTestId(`question-${q.id}-copy-status`)).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(q.prompt);
	}
});

test("默认只选中 thibault,其余题可手动勾选", async ({ page, questions }) => {
	await page.goto("/");
	await expect(page.getByTestId("question-thibault-toggle")).toBeChecked();
	for (const q of questions.filter((x) => x.id !== "thibault")) {
		const toggle = page.getByTestId(`question-${q.id}-toggle`);
		await expect(toggle).not.toBeChecked();
		await toggle.check();
		await expect(toggle).toBeChecked();
	}
});

test("首屏在 CSP 下无违规", async ({ page }) => {
	const violations: string[] = [];
	// Chrome logs blocked resources as console errors; the init script also reports violation events.
	page.on("console", (msg) => {
		if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
	});
	await page.addInitScript(() => {
		document.addEventListener("securitypolicyviolation", (e) =>
			console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`),
		);
	});
	await page.goto("/");
	await expect(page.getByTestId("start-button")).toBeVisible();
	await expect(page.getByTestId("tab-watch")).toBeVisible();
	expect(violations).toEqual([]);
});

test("手机宽度无横向滚动", async ({ page }, testInfo) => {
	test.skip(!testInfo.project.use.isMobile, "只在手机项目检查");
	await page.goto("/");
	await expect(page.getByTestId("start-button")).toBeVisible();
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("深色模式可渲染", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/");
	await expect(page.getByTestId("start-button")).toBeVisible();
	// Canvas normalises any CSS colour syntax (oklch, color()) to sRGB bytes.
	const luminance = await page.evaluate(() => {
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) return null;
		const pixel = (color: string) => {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = color;
			ctx.fillRect(0, 0, 1, 1);
			return ctx.getImageData(0, 0, 1, 1).data;
		};
		const bg = [document.body, document.documentElement]
			.map((el) => pixel(getComputedStyle(el).backgroundColor))
			.find((p) => p[3] > 0);
		return bg ? (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 : null;
	});
	expect(luminance ?? 1).toBeLessThan(0.5);
});

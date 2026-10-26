import { expect, scrubbed, startRun, test } from "./fixtures.ts";

// mock-slow streams each reply over about two seconds, which leaves the stage-1 race open long enough to cancel.
test("点取消后本轮结束，不会开新一轮", async ({ page, site, key, questions }) =>
	scrubbed(page, async () => {
		await startRun(page, { site, key, model: "mock-slow", select: ["thibault"], questions });
		await page.getByTestId("cancel-button").click();
		await expect(page.getByText("已取消。")).toBeVisible();
		await expect(page.getByTestId("start-button")).toBeVisible();
		await page.waitForTimeout(1000);
		await expect(page.getByTestId("cancel-button")).toHaveCount(0);
	}));

test("模型列表自动加载并可从下拉选择", async ({ page, site, key }) =>
	scrubbed(page, async () => {
		await page.goto("/");
		await page.getByTestId("site-input").fill(site);
		await page.getByTestId("key-input").fill(key);
		await expect(page.getByTestId("model-input-status")).toContainText("个模型", { timeout: 30_000 });
		await page.getByTestId("model-input-toggle").click();
		await expect(page.getByTestId("model-input-list")).toBeVisible();
		await page.getByTestId("model-input-option").filter({ hasText: "mock-good" }).click();
		await expect(page.getByTestId("model-input")).toHaveValue("mock-good");
		await expect(page.getByTestId("model-input-list")).not.toBeVisible();
	}));

test("custom 自定义题:规则为空或题面超 2000 码位时禁用测一次", async ({ page }) => {
	await page.goto("/");
	await page.getByTestId("custom-q-toggle").click();
	const run = page.getByTestId("custom-q-run");
	await expect(run).toBeDisabled();
	await page.getByTestId("custom-q-prompt").fill("Say OK.");
	await expect(run).toBeEnabled();
	await page.getByTestId("custom-q-scorer").selectOption("contains");
	await expect(run).toBeDisabled();
	await page.getByTestId("custom-q-contains").fill("OK");
	await expect(run).toBeEnabled();
	await page.getByTestId("custom-q-prompt").fill("😀".repeat(2001));
	await expect(page.getByTestId("custom-q-prompt-count")).toHaveText("2001/2000");
	await expect(page.getByTestId("custom-q-prompt-error")).toBeVisible();
	await expect(run).toBeDisabled();
});

test("custom 自定义题测一次答对,不进运行区", async ({ page, site, key }) =>
	scrubbed(page, async () => {
		await page.goto("/");
		await page.getByTestId("custom-q-toggle").click();
		await page.getByTestId("site-input").fill(site);
		await page.getByTestId("key-input").fill(key);
		await page.getByTestId("model-input").fill("mock-good");
		await page.getByTestId("custom-q-prompt").fill("Say OK.");
		await page.getByTestId("custom-q-scorer").selectOption("contains");
		await page.getByTestId("custom-q-contains").fill("OK");
		await page.getByTestId("custom-q-run").click();
		await expect(page.getByTestId("custom-q-verdict")).toHaveAttribute("data-state", "ok", { timeout: 30_000 });
		await expect(page.getByTestId("custom-q-verdict")).toHaveText("答对");
		await expect(page.getByTestId("custom-q-answer")).toHaveText("OK");
		await expect(page.getByTestId("call-dot")).toHaveCount(0);
	}));

test("custom 自定义题答错,回答按文本渲染", async ({ page, site, key }) =>
	scrubbed(page, async () => {
		await page.goto("/");
		await page.getByTestId("custom-q-toggle").click();
		await page.getByTestId("site-input").fill(site);
		await page.getByTestId("key-input").fill(key);
		await page.getByTestId("model-input").fill("mock-wrong");
		await page.getByTestId("custom-q-prompt").fill("Do you know Thibault? Answer YES or NO.");
		await page.getByTestId("custom-q-yes-no").selectOption("YES");
		await page.getByTestId("custom-q-run").click();
		await expect(page.getByTestId("custom-q-verdict")).toHaveAttribute("data-state", "wrong", { timeout: 30_000 });
		await expect(page.getByTestId("custom-q-verdict")).toHaveText("答错");
		await expect(page.getByTestId("custom-q-answer")).toContainText("<b>bold</b>");
		await expect(page.getByTestId("custom-q-answer").locator("b, img")).toHaveCount(0);
	}));

test("模型名含 claude 时协议自动切到 anthropic,经 /v1/messages 生成后可播放", async ({ page, site, key }) =>
	scrubbed(page, async () => {
		await page.goto("/#html");
		await page.getByTestId("html-site").fill(site);
		await page.getByTestId("html-key").fill(key);
		await page.getByTestId("html-model").fill("mock-claude");
		await expect(page.getByTestId("html-protocol")).toHaveValue("anthropic");
		await page.getByTestId("html-run").click();
		await expect(page.getByTestId("html-play")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("html-result")).toContainText("协议 anthropic");
	}));

test("HTML 生成页签按所选推理强度调用一次,生成中切走再切回不中断,生成后可下载 HTML 并播放动画", async ({ page, site, key }) =>
	scrubbed(page, async () => {
		await page.goto("/#html");
		await page.getByTestId("html-site").fill(site);
		await page.getByTestId("html-key").fill(key);
		await page.getByTestId("html-model").fill("mock-slow");
		await page.getByTestId("html-effort").selectOption("xhigh");
		await page.getByTestId("html-run").click();
		await expect(page.getByTestId("html-cancel")).toBeVisible();
		await page.getByTestId("tab-live").click();
		await page.getByTestId("tab-html").click();
		await expect(page.getByTestId("html-play")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("html-result")).toContainText("推理强度 xhigh");
		await expect(page.getByTestId("html-shown-prompt")).toContainText("骑自行车的2D动画，场景是");
		await expect(page.getByTestId("html-prompt")).toHaveCount(0);
		const pending = page.waitForEvent("download");
		await page.getByTestId("html-download").click();
		const download = await pending;
		expect(download.suggestedFilename()).toMatch(/^mock-slow-\d{8}-\d{6}\.html$/);
		expect(await download.failure()).toBeNull();
		await page.getByTestId("html-play").click();
		await expect(page.locator("iframe.animation-frame")).toBeVisible();
		await expect(page.getByTestId("call-dot")).toHaveCount(0);
	}));

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

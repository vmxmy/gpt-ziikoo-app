import { test as base, expect, type Page } from "@playwright/test";
import type { OverallStatus, QuestionListItem } from "../src/shared/types.ts";

export { expect };

export type E2eOptions = { mockUrl: string };

type Fixtures = { site: string; key: string; questions: QuestionListItem[] };

export const test = base.extend<Fixtures, E2eOptions>({
	mockUrl: ["", { option: true, scope: "worker" }],
	site: async ({ mockUrl }, use) => {
		if (!URL.canParse(mockUrl) || new URL(mockUrl).protocol !== "https:") {
			throw new Error("MOCK_URL 必填,且必须是 mock 中转站的公网 https 地址");
		}
		await use(mockUrl);
	},
	// One fresh key per test isolates the Durable Object, so tests never see each other's history.
	key: async ({ request, site }, use) => {
		const key = `sk-e2e-${crypto.randomUUID().replaceAll("-", "")}`;
		await use(key);
		const res = await request.post("/api/history/delete", { data: { site, key } });
		expect(res.status()).toBe(200);
	},
	// The live tab's checklist: the HTML question runs only from its own tab.
	questions: async ({ request }, use) => {
		const res = await request.get("/api/questions");
		expect(res.status()).toBe(200);
		const list: QuestionListItem[] = await res.json();
		await use(list.filter((q) => q.id !== "pelican-svg"));
	},
	page: async ({ page }, use) => {
		page.on("dialog", (dialog) => void dialog.accept());
		await use(page);
	},
});

// Playwright takes the failure screenshot as soon as the test function returns, before any hook,
// so the key must be wiped inside the test body. Writing .value directly cannot throw on a
// disabled input and so never masks the original failure.
export async function scrubbed(page: Page, body: () => Promise<void>): Promise<void> {
	try {
		await body();
	} finally {
		await page.locator('[data-testid="key-input"], [data-testid="html-key"]').evaluateAll((inputs) => {
			for (const input of inputs) if (input instanceof HTMLInputElement) input.value = "";
		});
	}
}

export type RunSetup = { site: string; key: string; model: string; select: string[]; questions: QuestionListItem[] };

export async function fillForm(page: Page, { site, key, model, select, questions }: RunSetup): Promise<void> {
	await page.goto("/");
	for (const q of questions) await page.getByTestId(`question-${q.id}-toggle`).setChecked(select.includes(q.id));
	await page.getByTestId("site-input").fill(site);
	await page.getByTestId("key-input").fill(key);
	await page.getByTestId("model-input").fill(model);
}

export async function startRun(page: Page, setup: RunSetup): Promise<void> {
	await fillForm(page, setup);
	await page.getByTestId("start-button").click();
}

export const RUN_TIMEOUT_MS = 240_000;

export async function expectOverall(page: Page, status: OverallStatus): Promise<void> {
	await expect(page.getByTestId("overall-result")).toHaveAttribute("data-status", status, { timeout: RUN_TIMEOUT_MS });
}

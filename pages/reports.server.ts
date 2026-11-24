import { defineHandler, defineHead, type InferProps } from "void";
import { ai } from "void/ai";
import { getUser, requireAuth } from "void/auth";
import { and, db, desc, eq } from "void/db";
import { UsageLimit } from "void/limits";
import { reports } from "../db/schema.ts";
import type { ReportSummary, SavedReport } from "../src/shared/reports.ts";
import { resolveAuthProviders } from "../src/worker/auth-providers.ts";

export type Props = InferProps<typeof loader>;

const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_REPORTS = 50;
const MAX_DIAGNOSIS_CHARS = 2000;

function parseSummary(raw: string): ReportSummary {
	try {
		const data = JSON.parse(raw) as Partial<ReportSummary>;
		return {
			totalCalls: typeof data.totalCalls === "number" ? data.totalCalls : 0,
			passedCalls: typeof data.passedCalls === "number" ? data.passedCalls : 0,
			failedCalls: typeof data.failedCalls === "number" ? data.failedCalls : 0,
			...(typeof data.p50Ms === "number" && { p50Ms: data.p50Ms }),
			...(typeof data.ttftP50Ms === "number" && { ttftP50Ms: data.ttftP50Ms }),
			...(typeof data.note === "string" && { note: data.note }),
		};
	} catch {
		return { totalCalls: 0, passedCalls: 0, failedCalls: 0 };
	}
}

async function readReportId(c: { req: { json: () => Promise<unknown> } }): Promise<string | null> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		body = undefined;
	}
	const id = typeof (body as { id?: unknown } | undefined)?.id === "string" ? (body as { id: string }).id.trim() : "";
	return id || null;
}

function diagnosisPrompt(row: { host: string; model: string; protocol: string; overall: string }, summary: ReportSummary): string {
	const lines = [
		`目标主机：${row.host}`,
		`模型：${row.model}`,
		`协议：${row.protocol}`,
		`总评：${row.overall}`,
		`总调用数：${summary.totalCalls}`,
		`答对调用数：${summary.passedCalls}`,
		`失败/答错调用数：${summary.failedCalls}`,
		...(summary.p50Ms !== undefined ? [`总耗时中位数：${summary.p50Ms} ms`] : []),
		...(summary.ttftP50Ms !== undefined ? [`首字耗时中位数：${summary.ttftP50Ms} ms`] : []),
		...(summary.note ? [`说明：${summary.note}`] : []),
	];
	return lines.join("\n");
}

function extractAiText(result: unknown): string {
	if (typeof result === "string") return result.trim().slice(0, MAX_DIAGNOSIS_CHARS);
	if (typeof result === "object" && result !== null && "response" in result) {
		const text = (result as { response?: unknown }).response;
		if (typeof text === "string") return text.trim().slice(0, MAX_DIAGNOSIS_CHARS);
	}
	return "";
}

export const head = defineHead(() => ({
	title: "报告归档 - GPT 降智测试",
	meta: [{ name: "description", content: "登录后查看并诊断已归档的脱敏测试报告" }],
}));

export const loader = defineHandler(async (c) => {
	const providers = resolveAuthProviders(c.env as unknown as Record<string, string | undefined>);
	const user = getUser();
	if (!user) {
		return { user: null, reports: [] as SavedReport[], providers };
	}
	const rows = await db
		.select()
		.from(reports)
		.where(eq(reports.userId, user.id))
		.orderBy(desc(reports.createdAt))
		.limit(MAX_REPORTS);

	const items: SavedReport[] = rows.map((row) => ({
		id: row.id,
		host: row.host,
		model: row.model,
		protocol: row.protocol,
		overall: row.overall,
		summary: parseSummary(row.summaryJson),
		aiDiagnosis: row.aiDiagnosis,
		createdAt: row.createdAt,
	}));

	return {
		user: { id: user.id, email: user.email, name: user.name },
		reports: items,
		providers,
	};
});

export const actions = {
	diagnose: defineHandler(async (c) => {
		const user = requireAuth(c);
		const id = await readReportId(c);
		if (!id) return c.text("缺少报告 id", 400);
		const [row] = await db
			.select()
			.from(reports)
			.where(and(eq(reports.id, id), eq(reports.userId, user.id)))
			.limit(1);
		if (!row) return c.text("报告不存在或无权访问", 404);

		const summary = parseSummary(row.summaryJson);
		let text = "";
		try {
			const res = await ai.run(AI_MODEL, {
				messages: [
					{
						role: "system",
						content: "你是 API 站点质量诊断助手。根据下面脱敏后的测试数值摘要，用简练中文给出 2 到 3 句诊断建议（分析通过率、延迟与可能原因），不要输出 Markdown 标题。",
					},
					{
						role: "user",
						content: diagnosisPrompt(row, summary),
					},
				],
			});
			text = extractAiText(res);
		} catch (error) {
			if (error instanceof UsageLimit) {
				return error.response({ message: "AI 诊断额度已达上限，请稍后再试" });
			}
			return c.text("AI 诊断服务暂时不可用，请稍后再试", 502);
		}

		if (!text) {
			return c.text("AI 诊断未返回有效结果", 502);
		}

		await db
			.update(reports)
			.set({ aiDiagnosis: text })
			.where(and(eq(reports.id, id), eq(reports.userId, user.id)));
	}),

	remove: defineHandler(async (c) => {
		const user = requireAuth(c);
		const id = await readReportId(c);
		if (!id) return c.text("缺少报告 id", 400);
		await db.delete(reports).where(and(eq(reports.id, id), eq(reports.userId, user.id)));
	}),
};

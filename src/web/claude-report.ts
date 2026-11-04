import { CLAUDE_CASES, type CaseVerdict, type ClaudeCaseResult } from "../shared/claude-cases.ts";
import { escapeHtml } from "./report.ts";

export const CLAUDE_VERDICT: Record<CaseVerdict, string> = { pass: "通过", fail: "未通过", gap: "协议缺口", untested: "未测" };
export type ClaudeReport = { host: string; model: string; at: Date; results: ClaudeCaseResult[] };

export function summarizeClaude(results: ClaudeCaseResult[]) {
	const failures = results.filter((result) => result.verdict !== "pass" && !(result.id === "C10" && result.verdict === "gap") && !(result.id === "P3" && result.verdict === "untested"));
	const sources = (["anthropic", "bedrock", "vertex", "other"] as const)
		.map((source) => ({ source, count: results.filter((result) => result.source === source).length }))
		.filter(({ count }) => count > 0);
	return {
		usable: ["C1", "C2"].every((id) => results.some((result) => result.id === id && result.verdict === "pass")),
		passed: results.filter((result) => result.verdict === "pass").length,
		failures,
		requiredChanges: failures.filter((result) => result.id !== "C1" && result.id !== "C2"),
		sources,
		calls: results.flatMap((result) => result.calls.map((call, index) => ({ id: result.id, index: index + 1, ...call }))),
	};
}

export function claudeCaseTitle(result: ClaudeCaseResult): string {
	return `${result.id} ${CLAUDE_CASES.find(({ id }) => id === result.id)!.title}`;
}

function table(head: string[], rows: string[][]): string {
	const cells = (tag: "th" | "td", row: string[]) => row.map((text) => `<${tag}>${escapeHtml(text)}</${tag}>`).join("");
	return `<table><thead><tr>${cells("th", head)}</tr></thead><tbody>${rows.map((row) => `<tr>${cells("td", row)}</tr>`).join("")}</tbody></table>`;
}

export function buildClaudeReport(run: ClaudeReport): string {
	const summary = summarizeClaude(run.results);
	const title = `Claude 专项：${run.host} · ${run.model}`;
	return [
		`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>`,
		`<h1>${escapeHtml(title)}</h1>`,
		"<h2>测试条件</h2>",
		table(["条件", "内容"], [["站点", run.host], ["模型", run.model], ["协议", "anthropic"], ["时间", run.at.toISOString()]]),
		"<h2>结论</h2>",
		`<p>${summary.usable ? "可用" : "不可用"}；通过 ${summary.passed} / ${CLAUDE_CASES.length}</p>`,
		`<p>必须上游修改项：${escapeHtml(summary.requiredChanges.map(claudeCaseTitle).join("、") || "无")}</p>`,
		"<h2>用例矩阵</h2>",
		table(["用例", "做了什么", "通过标准", "结论", "说明", "回答预览"], CLAUDE_CASES.map((entry) => {
			const result = run.results.find(({ id }) => id === entry.id);
			return [`${entry.id} ${entry.title}`, entry.does, entry.expect, result ? CLAUDE_VERDICT[result.verdict] : "未测", result?.note ?? "", result?.preview ?? "—"];
		})),
		"<h2>不通过清单</h2>",
		summary.failures.length ? table(["用例", "结论", "说明"], summary.failures.map((result) => [claudeCaseTitle(result), CLAUDE_VERDICT[result.verdict], result.note])) : "<p>无</p>",
		"<h2>来源判断</h2><p>按 source 汇总，仅供参考，不能据此确认模型身份。</p>",
		summary.sources.length ? table(["source", "用例数"], summary.sources.map(({ source, count }) => [source, String(count)])) : "<p>无来源信息</p>",
		"<h2>Request ID</h2>",
		table(["用例", "调用", "状态码", "Request ID", "耗时 ms"], summary.calls.map((call) => [call.id, String(call.index), String(call.status ?? "—"), call.requestId ?? "—", String(call.ms)])),
		"<h2>原始数据</h2><p>本站不保存原始数据</p>",
		"</body></html>",
	].join("\n");
}

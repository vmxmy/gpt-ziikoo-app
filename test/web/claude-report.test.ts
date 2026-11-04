import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CASES, type ClaudeCaseResult } from "../../src/shared/claude-cases.ts";
import { buildClaudeReport, summarizeClaude } from "../../src/web/claude-report.ts";
import { runClaudeCase, runClaudeCases } from "../../src/web/api.ts";

const results = (): ClaudeCaseResult[] => CLAUDE_CASES.map(({ id }) => ({
	id,
	verdict: id === "P3" ? "untested" : id === "C10" ? "gap" : "pass",
	note: id === "P3" ? "批量接口会创建异步任务并计费，本站不测" : "完成",
	preview: null,
	source: id === "C1" ? "bedrock" : null,
	calls: id === "P3" ? [] : [{ status: id === "C10" ? 404 : 200, requestId: `req_${id}`, ms: 12 }],
}));

describe("Claude protocol report", () => {
	it.each(["C1", "C2"])("is unavailable when %s does not pass", (id) => {
		const run = results().map((result) => result.id === id ? { ...result, verdict: "fail" as const } : result);
		const summary = summarizeClaude(run);
		expect(summary.usable).toBe(false);
		expect(summary.passed).toBe(10);
		expect(summary.failures.map((result) => result.id)).toEqual([id]);
		expect(summary.requiredChanges).toEqual([]);
	});

	it("keeps protocol gaps and untested batches distinct from passes and required changes", () => {
		const summary = summarizeClaude(results());
		expect(summary.usable).toBe(true);
		expect(summary.passed).toBe(11);
		expect(summary.requiredChanges).toEqual([]);
		expect(summary.failures).toEqual([]);
		expect(summary.sources).toEqual([{ source: "bedrock", count: 1 }]);
		expect(summarizeClaude([]).usable).toBe(false);
	});

	it("requires upstream changes for nonessential failures without making the protocol unavailable", () => {
		const summary = summarizeClaude(results().map((result) => result.id === "C8" || result.id === "P2" ? { ...result, verdict: "fail" as const } : result));
		expect(summary.usable).toBe(true);
		expect(summary.passed).toBe(9);
		expect(summary.requiredChanges.map((result) => result.id)).toEqual(["C8", "P2"]);
		expect(summary.calls).toHaveLength(12);
	});

	it("builds the protocol report with seven chapters, every call and escaped site text", () => {
		const run = results();
		run[2] = { ...run[2]!, verdict: "fail", note: `<img src=x onerror="alert('x')"> &`, preview: "<script>bad</script>" };
		run[1]!.calls.push({ status: 200, requestId: 'req_<unsafe>"', ms: 23 }, { status: null, requestId: null, ms: 30 });
		const html = buildClaudeReport({ host: "example.test", model: "claude<test>", at: new Date("2026-11-05T01:02:03Z"), results: run });
		expect([...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((match) => match[1])).toEqual([
			"测试条件", "结论", "用例矩阵", "不通过清单", "来源判断", "Request ID", "原始数据",
		]);
		expect(html).toContain("可用");
		expect(html).toContain("通过 10 / 13");
		expect(html).toContain("必须上游修改项");
		expect(html).toContain("C3 图片理解");
		expect(html).toContain("仅供参考");
		expect(html).toContain("bedrock");
		expect(html).toContain("本站不保存原始数据");
		expect(html).toContain("anthropic");
		expect(html).toContain("2026-11-05T01:02:03.000Z");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp;");
		expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
		expect(html).toContain("req_&lt;unsafe&gt;&quot;");
		expect(html).toContain("claude&lt;test&gt;");
		expect(html).not.toMatch(/<script|<img|style=|<style/);
		for (const id of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "P1", "P2"]) expect(html).toContain(`req_${id}`);
		expect(html).toContain("<td>C2</td><td>3</td><td>—</td><td>—</td><td>30</td>");
	});
});

describe("Claude case execution", () => {
	afterEach(() => vi.unstubAllGlobals());
	const request = { site: "https://example.test", key: "sk-private-abcdef", model: "claude-test" };

	it("runs the thirteen cases in order with only one request in flight", async () => {
		const sent: string[] = [];
		let active = 0;
		vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
			expect(path).toBe("/api/claude-case");
			expect(init.headers).toEqual({ "Content-Type": "application/json" });
			expect(init.signal).toBeInstanceOf(AbortSignal);
			active += 1;
			expect(active).toBe(1);
			await Promise.resolve();
			const body = JSON.parse(String(init.body));
			expect(body).toEqual({ ...request, case: body.case });
			sent.push(body.case);
			active -= 1;
			return Response.json(results().find((result) => result.id === body.case));
		});
		const progress: string[] = [];
		const run = await runClaudeCases(request, new AbortController().signal, (id) => progress.push(id));
		expect(sent).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "P1", "P2", "P3"]);
		expect(progress).toEqual(sent);
		expect(run).toHaveLength(13);
	});

	it("cancels an in-flight case without starting another case", async () => {
		const controller = new AbortController();
		const fetch = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
		}));
		vi.stubGlobal("fetch", fetch);
		const run = runClaudeCases(request, controller.signal, () => {});
		controller.abort();
		expect(await run).toBeNull();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("redacts an echoed credential before results reach the page or report", async () => {
		vi.stubGlobal("fetch", async () => Response.json({ ...results()[0], note: `Bearer ${request.key}`, preview: request.key, calls: [{ status: 200, requestId: request.key, ms: 3 }], extra: request.key }));
		const result = await runClaudeCase({ ...request, case: "C1" });
		expect(result.note).toBe("[redacted]");
		expect(result.preview).toBe("[redacted]");
		expect(result.calls[0]!.requestId).toBe("[redacted]");
		expect(JSON.stringify(result)).not.toContain(request.key);
	});

	it("redacts API error text and stops the sequence on a rate limit", async () => {
		const fetch = vi.fn(async () => Response.json({ error: "too_many_calls", message: `Bearer ${request.key}` }, { status: 429 }));
		vi.stubGlobal("fetch", fetch);
		await expect(runClaudeCases(request, new AbortController().signal, () => {})).rejects.toThrow("[redacted]");
		expect(fetch).toHaveBeenCalledOnce();
	});
});

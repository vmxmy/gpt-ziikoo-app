/// <reference types="vite/client" />
import { useRef, useState } from "preact/hooks";
import { CLAUDE_CASES, type ClaudeCaseId, type ClaudeCaseResult } from "../shared/claude-cases.ts";
import { missingFields, runClaudeCases } from "./api.ts";
import { buildClaudeReport, claudeCaseTitle, CLAUDE_VERDICT, summarizeClaude, type ClaudeReport } from "./claude-report.ts";
import { downloadReport, reportFileName } from "./report.ts";
import { normalizeKey } from "./results.ts";
import { SecretInput } from "./test-form.tsx";
import { parseSite } from "./watch.ts";
import "./claude.css";

function ClaudeSummary({ run }: { run: ClaudeReport }) {
	const summary = summarizeClaude(run.results);
	return (
		<div class="claude-report" data-testid="claude-result">
			<h3>结论</h3>
			<p>
				<span class="claude-verdict" data-verdict={summary.usable ? "pass" : "fail"} data-testid="claude-verdict">{summary.usable ? "可用" : "不可用"}</span>
				{` · 通过 ${summary.passed} / ${CLAUDE_CASES.length}`}
			</p>
			<p>必须上游修改项：{summary.requiredChanges.map(claudeCaseTitle).join("、") || "无"}</p>
			<h3>不通过清单</h3>
			{summary.failures.length > 0 ? <ul>{summary.failures.map((result) => <li key={result.id}>{claudeCaseTitle(result)}：{result.note}</li>)}</ul> : <p>无</p>}
			<h3>来源判断</h3>
			<p class="muted small">按 source 汇总，仅供参考，不能据此确认模型身份。</p>
			{summary.sources.length > 0 ? <ul>{summary.sources.map(({ source, count }) => <li key={source}>{source}：{count} 个用例</li>)}</ul> : <p>无来源信息</p>}
			<h3>Request ID</h3>
			<div class="table-wrap">
				<table data-testid="claude-requests">
					<thead><tr><th>用例</th><th>调用</th><th>状态码</th><th>Request ID</th><th>耗时 ms</th></tr></thead>
					<tbody>{summary.calls.map((call) => <tr key={`${call.id}-${call.index}`}><td>{call.id}</td><td>{call.index}</td><td>{call.status ?? "—"}</td><td>{call.requestId ?? "—"}</td><td>{call.ms}</td></tr>)}</tbody>
				</table>
			</div>
			<button type="button" class="btn" data-testid="claude-download" onClick={() => downloadReport(buildClaudeReport(run), reportFileName(run.host, run.model, "claude_protocol"))}>下载报告</button>
		</div>
	);
}

export function ClaudeTest() {
	const [site, setSite] = useState("");
	const [model, setModel] = useState("");
	const [results, setResults] = useState<ClaudeCaseResult[]>([]);
	const [active, setActive] = useState<ClaudeCaseId | null>(null);
	const [run, setRun] = useState<ClaudeReport | null>(null);
	const [error, setError] = useState("");
	const [cancelled, setCancelled] = useState(false);
	const controller = useRef<AbortController | null>(null);
	const keyInput = useRef<HTMLInputElement>(null);
	const running = active !== null;

	const start = async () => {
		if (controller.current) return;
		const target = { site: site.trim(), key: normalizeKey(keyInput.current?.value ?? "") };
		const missing = missingFields(target, model);
		if (missing.length) return setError(`请填写${missing.join("、")}`);
		const parsed = parseSite(target.site);
		if (!parsed.ok) return setError(parsed.message);
		const abort = new AbortController();
		controller.current = abort;
		const info = { host: parsed.host, model: model.trim(), at: new Date() };
		setError("");
		setCancelled(false);
		setRun(null);
		setResults([]);
		try {
			const completed = await runClaudeCases({ ...target, model: info.model }, abort.signal, (id, previous) => {
				setActive(id);
				setResults(previous);
			});
			if (completed === null) setCancelled(true);
			else {
				setResults(completed);
				setRun({ ...info, results: completed });
			}
		} catch (error) {
			setError(error instanceof Error ? error.message : "用例执行失败，请稍后重试");
		} finally {
			setActive(null);
			controller.current = null;
		}
	};

	return (
		<section class="panel" aria-labelledby="claude-h">
			<h2 id="claude-h">Claude 专项</h2>
			<p class="muted small">协议固定为 anthropic，依次执行 13 个用例，同一时刻只执行一个。批量接口不向站点发请求。密钥仅在调用时转发，结果不保存，刷新页面即失。</p>
			<form class="grid claude-form" onSubmit={(event) => { event.preventDefault(); void start(); }}>
				<label class="field col-12 col-md-6 col-lg-4">
					<span class="field-label">站点地址</span>
					<input data-testid="claude-site" value={site} onInput={(event) => setSite(event.currentTarget.value)} disabled={running} placeholder="https://api.example.com" />
				</label>
				<label class="field col-12 col-md-6 col-lg-4">
					<span class="field-label">密钥</span>
					<SecretInput inputRef={keyInput} testId="claude-key" />
				</label>
				<label class="field col-12 col-lg-4">
					<span class="field-label">模型</span>
					<input data-testid="claude-model" value={model} onInput={(event) => setModel(event.currentTarget.value)} disabled={running} placeholder="claude-..." />
				</label>
				<div class="actions col-12">
					<button type="submit" class="btn" disabled={running} data-testid="claude-run">{running ? "正在测试…" : "开始测试"}</button>
					{running && <button type="button" class="btn" data-testid="claude-cancel" onClick={() => controller.current?.abort()}>取消</button>}
				</div>
			</form>
			<div aria-live="polite">
				{error && <p class="warn" role="alert" data-testid="claude-error">{error}</p>}
				{cancelled && <p class="warn" data-testid="claude-cancelled">已取消，未完成的用例不计入结论。</p>}
				{running && <p data-testid="claude-progress">正在执行 {active} · 已完成 {results.length} / {CLAUDE_CASES.length}</p>}
			</div>
			<div class="table-wrap claude-matrix">
				<table data-testid="claude-matrix">
					<thead><tr><th>用例</th><th>做了什么</th><th>通过标准</th><th>结论</th><th>说明与回答预览</th></tr></thead>
					<tbody>{CLAUDE_CASES.map((entry) => {
						const result = results.find(({ id }) => id === entry.id);
						return <tr key={entry.id} data-testid={`claude-case-${entry.id}`}>
							<th scope="row">{entry.id} {entry.title}</th><td>{entry.does}</td><td>{entry.expect}</td>
							<td><span class="claude-verdict" data-verdict={result?.verdict} data-kind={active === entry.id ? "running" : undefined} data-testid={`claude-verdict-${entry.id}`}>{result ? CLAUDE_VERDICT[result.verdict] : active === entry.id ? "进行中" : cancelled ? "已取消" : "待执行"}</span></td>
							<td>{result?.note}{result?.preview && <p>{result.preview}</p>}</td>
						</tr>;
					})}</tbody>
				</table>
			</div>
			{run && <ClaudeSummary run={run} />}
		</section>
	);
}

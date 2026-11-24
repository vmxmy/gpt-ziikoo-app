/// <reference types="vite/client" />
import { useRef, useState } from "react";
import { CLAUDE_CASES, type ClaudeCaseId, type ClaudeCaseResult } from "../shared/claude-cases.ts";
import { missingFields, runClaudeCases, type Target } from "./api.ts";
import { buildClaudeReport, caseCounts, caseRows, CASE_STATE_LABEL, claudeCaseTitle, summarizeClaude, type CaseRow, type CaseState, type ClaudeReport } from "./claude-report.ts";
import { ModelField, type ModelList } from "./model-field.tsx";
import { fileHost, siteLabel, usePrivacy } from "./privacy.ts";
import { downloadReport, reportFileName } from "./report.ts";
import { parseSite } from "./watch.ts";
import "./claude.css";

// A running case reuses the live test's "进行中" tone; a case that has not run keeps the neutral fill.
const tone = (state: CaseState) => (state === "running" ? { "data-state": "pending" } : state === "waiting" || state === "cancelled" ? {} : { "data-verdict": state });

function CaseOverview({ rows }: { rows: CaseRow[] }) {
	return (
		<div className="claude-overview">
			<ol className="claude-strip" aria-hidden="true" data-testid="claude-strip">
				{rows.map((row) => (
					<li key={row.id} {...tone(row.state)} title={`${row.id} ${row.title}：${CASE_STATE_LABEL[row.state]}`} data-testid={`claude-strip-${row.id}`}>
						<span className="claude-strip-bar" />
						<span className="claude-strip-id">{row.id}</span>
					</li>
				))}
			</ol>
			<ul className="claude-counts" data-testid="claude-counts">
				{caseCounts(rows).map(([state, count]) => <li key={state} {...tone(state)}>{CASE_STATE_LABEL[state]} {count}</li>)}
			</ul>
		</div>
	);
}

function ClaudeSummary({ run }: { run: ClaudeReport }) {
	const privacy = usePrivacy();
	const summary = summarizeClaude(run.results);
	return (
		<div className="claude-report" data-testid="claude-result">
			<h3>结论</h3>
			<p>
				<span className="claude-verdict" data-verdict={summary.usable ? "pass" : "fail"} data-testid="claude-verdict">{summary.usable ? "可用" : "不可用"}</span>
				{` · 通过 ${summary.passed} / ${CLAUDE_CASES.length}`}
			</p>
			<p>必须上游修改项：{summary.requiredChanges.map(claudeCaseTitle).join("、") || "无"}</p>
			<h3>不通过清单</h3>
			{summary.failures.length > 0 ? <ul>{summary.failures.map((result) => <li key={result.id}>{claudeCaseTitle(result)}：{result.note}</li>)}</ul> : <p>无</p>}
			<h3>来源判断</h3>
			<p className="muted small">按 source 汇总，仅供参考，不能据此确认模型身份。</p>
			{summary.sources.length > 0 ? <ul>{summary.sources.map(({ source, count }) => <li key={source}>{source}：{count} 个用例</li>)}</ul> : <p>无来源信息</p>}
			<h3>Request ID</h3>
			<div className="table-wrap">
				<table data-testid="claude-requests">
					<thead><tr><th>用例</th><th>调用</th><th>状态码</th><th>Request ID</th><th>耗时 ms</th></tr></thead>
					<tbody>{summary.calls.map((call) => <tr key={`${call.id}-${call.index}`}><td>{call.id}</td><td>{call.index}</td><td>{call.status ?? "—"}</td><td>{call.requestId ?? "—"}</td><td>{call.ms}</td></tr>)}</tbody>
				</table>
			</div>
			<button type="button" className="btn" data-testid="claude-download" onClick={() => downloadReport(buildClaudeReport({ ...run, host: siteLabel(run.host, privacy) }), reportFileName(fileHost(run.host, privacy), run.model, "claude_protocol"))}>下载报告</button>
		</div>
	);
}

export function ClaudeTest({ target, models }: { target: Target; models: ModelList }) {
	const [model, setModel] = useState("");
	const [results, setResults] = useState<ClaudeCaseResult[]>([]);
	const [active, setActive] = useState<ClaudeCaseId | null>(null);
	const [run, setRun] = useState<ClaudeReport | null>(null);
	const [error, setError] = useState("");
	const [cancelled, setCancelled] = useState(false);
	const controller = useRef<AbortController | null>(null);
	const running = active !== null;
	const rows = caseRows(results, active, cancelled);
	const current = rows.find((row) => row.state === "running");

	const start = async () => {
		if (controller.current) return;
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
		<section className="panel" aria-labelledby="claude-h">
			<h2 id="claude-h">Claude 专项</h2>
			<p className="muted small">协议固定为 anthropic，依次执行 13 个用例，同一时刻只执行一个。批量接口不向站点发请求。密钥仅在调用时转发，结果不保存，刷新页面即失。</p>
			<form className="grid claude-form" onSubmit={(event) => { event.preventDefault(); void start(); }}>
				<ModelField value={model} onInput={setModel} list={models} testId="claude-model" class="col-12 col-lg-4" disabled={running} />
				<div className="actions col-12">
					<button type="submit" className="btn" disabled={running} data-testid="claude-run">{running ? "正在测试…" : "开始测试"}</button>
					{running && <button type="button" className="btn" data-testid="claude-cancel" onClick={() => controller.current?.abort()}>取消</button>}
				</div>
			</form>
			<div aria-live="polite">
				{error && <p className="warn" role="alert" data-testid="claude-error">{error}</p>}
				{cancelled && <p className="warn" data-testid="claude-cancelled">已取消，未完成的用例不计入结论。</p>}
				{current && <p data-testid="claude-progress">正在执行 {current.id} {current.title} · 已完成 {results.length} / {CLAUDE_CASES.length}</p>}
			</div>
			<CaseOverview rows={rows} />
			<div className="table-wrap claude-matrix">
				<table data-testid="claude-matrix">
					<thead><tr><th>用例</th><th>结论</th><th>做了什么</th><th>通过标准</th><th>说明与回答预览</th></tr></thead>
					<tbody>{rows.map((row) => (
						<tr key={row.id} data-active={row.state === "running" || undefined} data-testid={`claude-case-${row.id}`}>
							<th scope="row">{row.id} {row.title}</th>
							<td><span className="claude-verdict" {...tone(row.state)} data-testid={`claude-verdict-${row.id}`}>{CASE_STATE_LABEL[row.state]}</span></td>
							<td>{row.does}</td><td>{row.expect}</td>
							<td>{row.result?.note}{row.result?.preview && <p>{row.result.preview}</p>}</td>
						</tr>
					))}</tbody>
				</table>
			</div>
			{run && <ClaudeSummary run={run} />}
		</section>
	);
}

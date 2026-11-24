import { useEffect, useState } from "react";
import { STAGES, evaluateQuestion, summarizeRun } from "../shared/ladder.ts";
import type { Protocol } from "../shared/protocols.ts";
import type { ReportSummary } from "../shared/reports.ts";
import type { QuestionListItem, QuestionVerdict } from "../shared/types.ts";
import { saveReport } from "./api.ts";
import { promptUsage, TARGETED_RATIO, type UsageFinding } from "./prompt-usage.ts";
import { diagnosis, dotLabel, FAILURE_ADVICE, numberCheck, ms, OVERALL_LABEL, resultText, VERDICT_LABEL } from "./results.ts";
import { callState, ladderCalls, type Attempt, type RunSnapshot } from "./runner.ts";

const DOT_LEGEND = [
	["ok", "答对"],
	["wrong", "答错"],
	["fail", "失败"],
	["pending", "进行中"],
] as const;

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(sorted[Math.floor(sorted.length / 2)]!);
}

function buildReportSummary(attempts: Attempt[], protocol: Protocol | null, totalQuestions: number, passedQuestions: number): ReportSummary {
	const done = attempts.filter((a) => a.done && (protocol === null || a.protocol === protocol));
	const passedCalls = done.filter((a) => a.response?.ok && a.response.correct === true).length;
	const failedCalls = done.filter((a) => !a.response?.ok || a.response.correct === false).length;
	const totalMs = done.flatMap((a) => (a.response?.ok ? [a.response.totalMs] : []));
	const ttftMs = done.flatMap((a) => (a.response?.ok && a.response.ttftMs !== null ? [a.response.ttftMs] : []));
	const p50Ms = median(totalMs);
	const ttftP50Ms = median(ttftMs);
	return {
		totalCalls: done.length,
		passedCalls,
		failedCalls,
		...(p50Ms !== undefined && { p50Ms }),
		...(ttftP50Ms !== undefined && { ttftP50Ms }),
		note: `共 ${totalQuestions} 题，通过 ${passedQuestions} 题`,
	};
}

function Ladder({ id, attempts }: { id: string; attempts: Attempt[] }) {
	return (
		<ol className="stages" data-testid={`lane-${id}`}>
			{STAGES.map((s, i) => {
				const inStage = attempts.filter((a) => a.stage === i + 1);
				const correct = inStage.filter((a) => callState(a) === "ok").length;
				return (
					<li className="stage" data-testid={`stage-${i + 1}`} key={i}>
						<span className="stage-name">
							第 {i + 1} 关 <span className="muted">需 {s.need}/{s.calls}</span>
						</span>
						<span className="dots">
							{inStage.map((a) => (
								<span
									className="call-dot"
									data-testid="call-dot"
									data-state={callState(a)}
									role="img"
									aria-label={dotLabel(a)}
									title={dotLabel(a)}
									key={`${a.protocol}-${a.seq}-${a.attempt}`}
								/>
							))}
						</span>
						<span className="stage-count num">答对 {correct}</span>
					</li>
				);
			})}
		</ol>
	);
}

const DETAIL_COLUMNS = ["关", "序号", "尝试", "结果", "推理 token 数", "响应 ID 形态", "首字耗时", "总耗时", "回答片段"] as const;
const NUMERIC_COLUMNS = new Set(["关", "序号", "尝试", "推理 token 数", "首字耗时", "总耗时"]);

function DetailTable({ id, attempts }: { id: string; attempts: Attempt[] }) {
	const showNumberCheck = attempts.some((a) => numberCheck(a.response) !== "");
	const columns = [...DETAIL_COLUMNS, ...(showNumberCheck ? ["数字核对"] : [])];
	return (
		<details className="detail">
			<summary>逐次明细</summary>
			<div className="table-wrap table-scroll">
				<table data-testid={`detail-table-${id}`}>
					<thead>
						<tr>
							{columns.map((label) => (
								<th key={label} className={NUMERIC_COLUMNS.has(label) ? "num" : undefined}>
									{label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{attempts.map((a) => {
							const r = a.response?.ok ? a.response : null;
							const failure = !a.response?.ok ? (a.response ? FAILURE_ADVICE[a.response.reason].reason : "连不上本站接口") : null;
							return (
								<tr key={`${a.stage}-${a.seq}-${a.attempt}`}>
									<td className="num" data-label="关">{a.stage}</td>
									<td className="num" data-label="序号">{a.seq}</td>
									<td className="num" data-label="尝试">{a.attempt}</td>
									<td data-label="结果">{resultText(a)}</td>
									{failure === null ? (
										<>
											<td className="num" data-label="推理 token 数">{r?.reasoningTokens ?? "—"}</td>
											<td className="mono" data-label="响应 ID 形态">{r?.idShape ?? "—"}</td>
											<td className="num" data-label="首字耗时">{ms(r?.ttftMs)}</td>
											<td className="num" data-label="总耗时">{ms(r?.totalMs)}</td>
											<td className="answer" data-label="回答片段">{r?.answer ?? ""}</td>
											{showNumberCheck && <td className="num" data-label="数字核对">{numberCheck(a.response)}</td>}
										</>
									) : (
										<td colSpan={columns.length - 4} data-label="原因">{failure}</td>
									)}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</details>
	);
}

function QuestionResult(props: { q: QuestionListItem; v: QuestionVerdict; attempts: Attempt[]; protocol: Protocol | null; running: boolean }) {
	const { q, v, protocol, running } = props;
	// The lane keeps every probe of the question, including the stage-1 protocol race whose extra dot the e2e counts.
	const done = props.attempts.filter((a) => a.done && (protocol === null || a.protocol === protocol));
	return (
		<article className="verdict" data-testid={`verdict-${q.id}`} data-status={v.status}>
			<header className="verdict-head">
				<h3>{q.title}</h3>
				<span className="pill" data-status={v.status}>
					{running && v.status === "incomplete" ? "进行中" : VERDICT_LABEL[v.status]}
				</span>
			</header>
			<Ladder id={q.id} attempts={props.attempts} />
			<p data-testid={`diagnosis-${q.id}`}>{running && v.status === "incomplete" ? `正在测第 ${v.stage} 关。` : diagnosis(v, done, q.failureHint)}</p>
			<DetailTable id={q.id} attempts={done} />
		</article>
	);
}

const findingText = (f: UsageFinding): string =>
	f.kind === "global"
		? `thibault 的输入 token 数是 ${f.tokens}，正常约 20 到 35。站点可能给每次调用加了额外内容。在历史里下载原始数据，或测另一个站点对比，可以确认。`
		: `原题的输入比同结构的变体题多约 ${f.percent}%（参考阈值 ${TARGETED_RATIO * 100}%）。`;

function UsageCheck(props: { run: RunSnapshot; questions: QuestionListItem[]; seed: number }) {
	const { rows, findings } = promptUsage(props.run.attempts, props.questions, props.seed, props.run.protocol);
	if (rows.every((r) => r.medianTokens === null)) return null;
	return (
		<details className="verdict usage-check" data-testid="usage-check">
			<summary>输入用量核对（参考）</summary>
			<div className="table-wrap">
				<table>
					<thead>
						<tr>
							<th>题</th>
							<th className="num">调用</th>
							<th className="num">输入字数</th>
							<th className="num">输入 token 数中位数</th>
							<th className="num">每字 token</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.question}>
								<td>{r.title}</td>
								<td className="num">{r.calls}</td>
								<td className="num">{r.chars}</td>
								<td className="num">{r.medianTokens ?? "—"}</td>
								<td className="num">{r.perChar === null ? "—" : r.perChar.toFixed(2)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{findings.map((f) => (
				<p className="warn" key={f.kind} data-testid={`usage-finding-${f.kind}`}>
					{findingText(f)}
				</p>
			))}
			<p className="muted">参考指标，没有用真实站点校准。</p>
		</details>
	);
}

type ArchiveState =
	| { kind: "idle" }
	| { kind: "saving" }
	| { kind: "saved" }
	| { kind: "unauth" }
	| { kind: "error"; message: string };

export function Results(props: {
	run: RunSnapshot;
	running: boolean;
	questions: QuestionListItem[];
	seed: number;
	host?: string;
	model?: string;
	onRerun: (protocol?: Protocol) => void;
}) {
	const { run, running, questions, seed, host, model, onRerun } = props;
	const [archive, setArchive] = useState<ArchiveState>({ kind: "idle" });
	useEffect(() => {
		setArchive({ kind: "idle" });
	}, [run.runId]);

	const verdicts = questions.map((q) => ({ q, v: evaluateQuestion(ladderCalls(run.attempts, q.id, run.protocol)) }));
	const overall = summarizeRun(verdicts.map(({ v }) => v.status));
	const passed = verdicts.filter(({ v }) => v.status === "passed").length;
	const other = run.race.find((p) => p !== run.protocol) ?? run.race[0];
	const canArchive = run.finished && Boolean(host) && Boolean(model) && run.protocol !== null;

	const archiveReport = async () => {
		if (!host || !model || !run.protocol) return;
		setArchive({ kind: "saving" });
		try {
			const res = await saveReport({
				host,
				model,
				protocol: run.protocol,
				overall,
				summary: buildReportSummary(run.attempts, run.protocol, verdicts.length, passed),
			});
			if (res.ok) setArchive({ kind: "saved" });
			else if (res.unauthorized) setArchive({ kind: "unauth" });
			else setArchive({ kind: "error", message: res.message });
		} catch (err) {
			setArchive({ kind: "error", message: err instanceof Error ? err.message : "归档失败" });
		}
	};

	return (
		<section className="panel col-12" id="results" aria-labelledby="result-h">
			<div className="section-head">
				<h2 id="result-h">结果</h2>
				<ul className="dot-legend" aria-label="图例">
					{DOT_LEGEND.map(([state, label]) => (
						<li key={state}>
							<span className="call-dot" data-state={state} aria-hidden="true" />
							{label}
						</li>
					))}
				</ul>
			</div>
			<p className="muted" aria-live="polite">
				{running ? `进行中${run.protocol ? `，协议 ${run.protocol}` : "，正在确认协议"}` : "已结束"}
			</p>
			{run.finished && (
				<div className="overall" data-testid="overall-result" data-status={overall}>
					<div className="overall-main">
						<span className="overall-eyebrow">总评：</span><strong className="overall-label">{OVERALL_LABEL[overall]}</strong>
						{run.protocol && <span className="muted">（协议 {run.protocol}）</span>}{" "}
						<p className="muted">共 {verdicts.length} 题，通过 {passed} 题。</p>
					</div>
					<div className="actions">
						<button type="button" className="btn btn-secondary" onClick={() => onRerun()}>
							重新测试
						</button>
						{run.protocol && (
							<button type="button" className="btn btn-secondary" onClick={() => onRerun(other)}>
								也测另一协议（{other}）
							</button>
						)}
						{canArchive && (
							<button
								type="button"
								className="btn btn-secondary"
								disabled={archive.kind === "saving" || archive.kind === "saved"}
								onClick={() => void archiveReport()}
								data-testid="archive-report-button"
							>
								{archive.kind === "saving" ? "归档中…" : archive.kind === "saved" ? "已归档" : "归档报告"}
							</button>
						)}
					</div>
				</div>
			)}
			{archive.kind === "saved" && (
				<p className="muted small" role="status" data-testid="archive-report-status">
					已归档脱敏摘要。<a href="/reports">查看报告归档</a>
				</p>
			)}
			{archive.kind === "unauth" && (
				<p className="muted small" role="status" data-testid="archive-report-status">
					登录后可归档报告。<a href="/reports">前往登录</a>
				</p>
			)}
			{archive.kind === "error" && (
				<p className="warn small" role="alert" data-testid="archive-report-status">
					{archive.message}
				</p>
			)}
			{run.cancelled && <p className="warn">已取消。</p>}
			{run.stop && (
				<p className="warn" role="alert">
					{run.stop.message}
					{run.stop.retryAfterSec ? `，请 ${run.stop.retryAfterSec} 秒后再试。` : "。"}
				</p>
			)}
			{run.finished && (
				<p className="notice" data-testid="snapshot-notice">
					结果只代表此刻。同一站点一天内的结果会变化。耗时从本站服务器测到站点，不是从你的电脑测到站点。如果站点限制区域，结果会与你的电脑上的结果不同。
				</p>
			)}
			{verdicts.map(({ q, v }) => (
				<QuestionResult key={q.id} q={q} v={v} attempts={run.attempts.filter((a) => a.question === q.id)} protocol={run.protocol} running={running} />
			))}
			<UsageCheck run={run} questions={questions} seed={seed} />
		</section>
	);
}

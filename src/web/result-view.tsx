import { STAGES, evaluateQuestion, summarizeRun } from "../shared/ladder.ts";
import type { Protocol, QuestionListItem, QuestionVerdict } from "../shared/types.ts";
import { diagnosis, dotLabel, FAILURE_ADVICE, numberCheck, ms, OVERALL_LABEL, resultText, VERDICT_LABEL } from "./results.ts";
import { promptUsage, TARGETED_RATIO, type UsageFinding } from "./prompt-usage.ts";
import { callState, ladderCalls, type Attempt, type RunSnapshot } from "./runner.ts";

const DOT_LEGEND = [
	["ok", "答对"],
	["wrong", "答错"],
	["fail", "失败"],
	["pending", "进行中"],
] as const;

function Ladder({ id, attempts }: { id: string; attempts: Attempt[] }) {
	return (
		<ol class="stages" data-testid={`lane-${id}`}>
			{STAGES.map((s, i) => {
				const inStage = attempts.filter((a) => a.stage === i + 1);
				const correct = inStage.filter((a) => callState(a) === "ok").length;
				return (
					<li class="stage" data-testid={`stage-${i + 1}`} key={i}>
						<span class="stage-name">
							第 {i + 1} 关 <span class="muted">需 {s.need}/{s.calls}</span>
						</span>
						<span class="dots">
							{inStage.map((a) => (
								<span
									class="call-dot"
									data-testid="call-dot"
									data-state={callState(a)}
									role="img"
									aria-label={dotLabel(a)}
									title={dotLabel(a)}
									key={`${a.protocol}-${a.seq}-${a.attempt}`}
								/>
							))}
						</span>
						<span class="stage-count num">答对 {correct}</span>
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
		<details class="detail">
			<summary>逐次明细</summary>
			<div class="table-wrap table-scroll">
				<table data-testid={`detail-table-${id}`}>
					<thead>
						<tr>
							{columns.map((label) => (
								<th key={label} class={NUMERIC_COLUMNS.has(label) ? "num" : undefined}>
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
									<td class="num" data-label="关">{a.stage}</td>
									<td class="num" data-label="序号">{a.seq}</td>
									<td class="num" data-label="尝试">{a.attempt}</td>
									<td data-label="结果">{resultText(a)}</td>
									{failure === null ? (
										<>
											<td class="num" data-label="推理 token 数">{r?.reasoningTokens ?? "—"}</td>
											<td class="mono" data-label="响应 ID 形态">{r?.idShape ?? "—"}</td>
											<td class="num" data-label="首字耗时">{ms(r?.ttftMs)}</td>
											<td class="num" data-label="总耗时">{ms(r?.totalMs)}</td>
											<td class="answer" data-label="回答片段">{r?.answer ?? ""}</td>
											{showNumberCheck && <td class="num" data-label="数字核对">{numberCheck(a.response)}</td>}
										</>
									) : (
										<td colspan={columns.length - 4} data-label="原因">{failure}</td>
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
		<article class="verdict" data-testid={`verdict-${q.id}`} data-status={v.status}>
			<header class="verdict-head">
				<h3>{q.title}</h3>
				<span class="pill" data-status={v.status}>
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
		<details class="verdict usage-check" data-testid="usage-check">
			<summary>输入用量核对（参考）</summary>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>题</th>
							<th class="num">调用</th>
							<th class="num">输入字数</th>
							<th class="num">输入 token 数中位数</th>
							<th class="num">每字 token</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.question}>
								<td>{r.title}</td>
								<td class="num">{r.calls}</td>
								<td class="num">{r.chars}</td>
								<td class="num">{r.medianTokens ?? "—"}</td>
								<td class="num">{r.perChar === null ? "—" : r.perChar.toFixed(2)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{findings.map((f) => (
				<p class="warn" key={f.kind} data-testid={`usage-finding-${f.kind}`}>
					{findingText(f)}
				</p>
			))}
			<p class="muted">参考指标，没有用真实站点校准。</p>
		</details>
	);
}

export function Results(props: {
	run: RunSnapshot;
	running: boolean;
	questions: QuestionListItem[];
	seed: number;
	onRerun: (protocol?: Protocol) => void;
}) {
	const { run, running, questions, seed, onRerun } = props;
	const verdicts = questions.map((q) => ({ q, v: evaluateQuestion(ladderCalls(run.attempts, q.id, run.protocol)) }));
	const overall = summarizeRun(verdicts.map(({ v }) => v.status));
	const passed = verdicts.filter(({ v }) => v.status === "passed").length;
	const other = run.race.find((p) => p !== run.protocol) ?? run.race[0];
	return (
		<section class="panel col-12" id="results" aria-labelledby="result-h">
			<div class="section-head">
				<h2 id="result-h">结果</h2>
				<ul class="dot-legend" aria-label="图例">
					{DOT_LEGEND.map(([state, label]) => (
						<li key={state}>
							<span class="call-dot" data-state={state} aria-hidden="true" />
							{label}
						</li>
					))}
				</ul>
			</div>
			<p class="muted" aria-live="polite">
				{running ? `进行中${run.protocol ? `，协议 ${run.protocol}` : "，正在确认协议"}` : "已结束"}
			</p>
			{run.finished && (
				<div class="overall" data-testid="overall-result" data-status={overall}>
					<div class="overall-main">
						<span class="overall-eyebrow">总评：</span><strong class="overall-label">{OVERALL_LABEL[overall]}</strong>
						{run.protocol && <span class="muted">（协议 {run.protocol}）</span>}{" "}
						<p class="muted">共 {verdicts.length} 题，通过 {passed} 题。</p>
					</div>
					<div class="actions">
						<button type="button" class="btn btn-secondary" onClick={() => onRerun()}>
							重新测试
						</button>
						{run.protocol && (
							<button type="button" class="btn btn-secondary" onClick={() => onRerun(other)}>
								也测另一协议（{other}）
							</button>
						)}
					</div>
				</div>
			)}
			{run.cancelled && <p class="warn">已取消。</p>}
			{run.stop && (
				<p class="warn" role="alert">
					{run.stop.message}
					{run.stop.retryAfterSec ? `，请 ${run.stop.retryAfterSec} 秒后再试。` : "。"}
				</p>
			)}
			{run.finished && (
				<p class="notice" data-testid="snapshot-notice">
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

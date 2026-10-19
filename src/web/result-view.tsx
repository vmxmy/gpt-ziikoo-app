import { evaluateQuestion, summarizeRun } from "../shared/ladder.ts";
import type { Protocol, QuestionListItem, QuestionVerdict } from "../shared/types.ts";
import { diagnosis, failureAdvice, numberCheck, ms, OVERALL_LABEL, resultText, VERDICT_LABEL } from "./results.ts";
import { promptUsage, TARGETED_RATIO, type UsageFinding } from "./prompt-usage.ts";
import { ladderCalls, type Attempt, type RunSnapshot } from "./runner.ts";

function DetailTable({ id, attempts }: { id: string; attempts: Attempt[] }) {
	return (
		<div class="table-wrap table-scroll">
			<table data-testid={`detail-table-${id}`}>
				<thead>
					<tr>
						<th class="num">关</th>
						<th class="num">序号</th>
						<th class="num">尝试</th>
						<th>结果</th>
						<th class="num">推理 token 数</th>
						<th>响应 ID 形态</th>
						<th class="num">首字耗时</th>
						<th class="num">总耗时</th>
						<th>回答片段</th>
						<th>数字核对</th>
					</tr>
				</thead>
				<tbody>
					{attempts.map((a) => {
						const r = a.response?.ok ? a.response : null;
						return (
							<tr key={`${a.stage}-${a.seq}-${a.attempt}`}>
								<td class="num">{a.stage}</td>
								<td class="num">{a.seq}</td>
								<td class="num">{a.attempt}</td>
								<td>{resultText(a)}</td>
								<td class="num">{r?.reasoningTokens ?? "—"}</td>
								<td class="mono">{r?.idShape ?? "—"}</td>
								<td class="num">{ms(r?.ttftMs)}</td>
								<td class="num">{ms(r?.totalMs)}</td>
								<td class="answer">{r?.answer ?? ""}</td>
								<td class="num">{numberCheck(a.response)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function QuestionResult(props: { q: QuestionListItem; v: QuestionVerdict; attempts: Attempt[]; protocol: Protocol | null }) {
	const { q, v, protocol } = props;
	const attempts = props.attempts.filter((a) => a.done && (protocol === null || a.protocol === protocol));
	const advice = v.status === "unavailable" ? failureAdvice(attempts) : null;
	return (
		<article class="verdict" data-testid={`verdict-${q.id}`} data-status={v.status}>
			<header class="verdict-head">
				<h3>{q.title}</h3>
				<span class="pill" data-status={v.status}>
					{VERDICT_LABEL[v.status]}
				</span>
			</header>
			<p data-testid={`diagnosis-${q.id}`}>{diagnosis(v, attempts, q.failureHint)}</p>
			{advice && (
				<dl class="advice">
					<dt>原因</dt>
					<dd>{advice.reason}</dd>
					<dt>下一步</dt>
					<dd>{advice.next}</dd>
				</dl>
			)}
			<DetailTable id={q.id} attempts={attempts} />
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

export function Results(props: { run: RunSnapshot; questions: QuestionListItem[]; seed: number; onRerun: (protocol?: Protocol) => void }) {
	const { run, questions, seed, onRerun } = props;
	const verdicts = questions.map((q) => ({ q, v: evaluateQuestion(ladderCalls(run.attempts, q.id, run.protocol)) }));
	const overall = summarizeRun(verdicts.map(({ v }) => v.status));
	const passed = verdicts.filter(({ v }) => v.status === "passed").length;
	const other: Protocol = run.protocol === "chat" ? "responses" : "chat";
	return (
		<section class="block col-12" id="results" aria-labelledby="result-h">
			<h2 id="result-h">结果</h2>
			<div class="overall-block">
				<p class="overall" data-testid="overall-result" data-status={overall}>
					总评：{OVERALL_LABEL[overall]}
					{run.protocol && <span class="muted"> （协议 {run.protocol}）</span>}
				</p>
				<p class="muted">
					共 {verdicts.length} 题，通过 {passed} 题。
				</p>
			</div>
			{run.cancelled && <p class="warn">已取消。</p>}
			{run.stop && (
				<p class="warn" role="alert">
					{run.stop.message}
					{run.stop.retryAfterSec ? `，请 ${run.stop.retryAfterSec} 秒后再试。` : "。"}
				</p>
			)}
			<p class="notice" data-testid="snapshot-notice">
				结果只代表此刻。同一站点一天内的结果会变化。耗时从本站服务器测到站点，不是从你的电脑测到站点。如果站点限制区域，结果会与你的电脑上的结果不同。
			</p>
			{verdicts.map(({ q, v }) => (
				<QuestionResult key={q.id} q={q} v={v} attempts={run.attempts.filter((a) => a.question === q.id)} protocol={run.protocol} />
			))}
			<UsageCheck run={run} questions={questions} seed={seed} />
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
		</section>
	);
}

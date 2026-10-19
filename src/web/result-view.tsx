import { evaluateQuestion, summarizeRun } from "../shared/ladder.ts";
import type { Protocol, QuestionListItem, QuestionVerdict } from "../shared/types.ts";
import { diagnosis, failureAdvice, missingNumbers, ms, OVERALL_LABEL, resultText, VERDICT_LABEL } from "./results.ts";
import { ladderCalls, type Attempt, type RunSnapshot } from "./runner.ts";

function DetailTable({ id, attempts }: { id: string; attempts: Attempt[] }) {
	return (
		<div class="table-wrap table-scroll">
			<table data-testid={`detail-table-${id}`}>
				<thead>
					<tr>
						<th>关·次·尝试</th>
						<th>结果</th>
						<th class="num">reasoning tokens</th>
						<th>idShape</th>
						<th class="num">首字耗时</th>
						<th class="num">总耗时</th>
						<th>回答片段</th>
						<th>缺失数字</th>
					</tr>
				</thead>
				<tbody>
					{attempts.map((a) => {
						const r = a.response?.ok ? a.response : null;
						return (
							<tr key={`${a.stage}-${a.seq}-${a.attempt}`}>
								<td class="mono">
									{a.stage}·{a.seq}·{a.attempt}
								</td>
								<td>{resultText(a)}</td>
								<td class="num">{r?.reasoningTokens ?? "—"}</td>
								<td class="mono">{r?.idShape ?? "—"}</td>
								<td class="num">{ms(r?.ttftMs)}</td>
								<td class="num">{ms(r?.totalMs)}</td>
								<td class="answer">{r?.answer ?? ""}</td>
								<td class="num">{missingNumbers(a.response)}</td>
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

export function Results(props: { run: RunSnapshot; questions: QuestionListItem[]; onRerun: (protocol?: Protocol) => void }) {
	const { run, questions, onRerun } = props;
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
				结果只代表此刻，同一站点一天内可能翻转。时延从 Cloudflare 边缘测到站点，不是你本机到站点；区域受限的站点结果可能与本机不同。
			</p>
			{verdicts.map(({ q, v }) => (
				<QuestionResult key={q.id} q={q} v={v} attempts={run.attempts.filter((a) => a.question === q.id)} protocol={run.protocol} />
			))}
			<div class="actions">
				<button type="button" class="btn btn-secondary" onClick={() => onRerun()}>
					再测
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

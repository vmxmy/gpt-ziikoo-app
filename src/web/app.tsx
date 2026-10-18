import { useEffect, useRef, useState } from "preact/hooks";
import { evaluateQuestion, STAGES, summarizeRun } from "../shared/ladder.ts";
import type { Protocol, QuestionListItem, QuestionVerdict } from "../shared/types.ts";
import { fetchQuestions, makeProbe } from "./api.ts";
import { ApiDocs } from "./docs.tsx";
import { History } from "./history.tsx";
import { Monitor } from "./monitor.tsx";
import {
	costLine,
	diagnosis,
	dotLabel,
	failureAdvice,
	MAX_CALLS_PER_QUESTION,
	missingNumbers,
	ms,
	normalizeKey,
	OVERALL_LABEL,
	resultText,
	VERDICT_LABEL,
} from "./results.ts";
import { callState, ladderCalls, runLadder, type Attempt, type RunSnapshot } from "./runner.ts";

const DEFAULT_MODEL = "gpt-6-astra";
const PRIVACY =
	"本站不保存你的密钥。为了对比历史，我们保存站点主机名、测试结果和站点返回的原始响应，最近 10 轮，闲置 90 天后自动删除。凭同一站点和同一密钥可查看或立即删除。密钥只在每次测试时转发给你填写的站点";

const KIND_LABEL: Record<QuestionListItem["kind"], string> = { knowledge: "知识", reasoning: "推理", metrics: "度量" };

type CopyStatus = "copied" | "failed";

function QuestionRow(props: {
	q: QuestionListItem;
	checked: boolean;
	locked: boolean;
	model: string;
	onToggle: () => void;
}) {
	const { q, checked, locked, model, onToggle } = props;
	const [open, setOpen] = useState(false);
	const [copy, setCopy] = useState<CopyStatus | null>(null);
	const doCopy = () => {
		const write = navigator.clipboard?.writeText(q.prompt) ?? Promise.reject(new Error("clipboard unavailable"));
		write.then(
			() => setCopy("copied"),
			() => setCopy("failed"),
		);
	};
	return (
		<li class="question" data-testid={`question-${q.id}`}>
			<label class="question-head">
				<input
					type="checkbox"
					checked={checked}
					disabled={checked && locked}
					onChange={onToggle}
					data-testid={`question-${q.id}-toggle`}
				/>
				<span class="question-title">{q.title}</span>
				<span class="tag">{KIND_LABEL[q.kind]}</span>
				<span class="muted">v{q.version}</span>
			</label>
			<p>{q.measures}</p>
			<p class="muted">
				标准答案：{q.expectedLabel}。最多调用 {MAX_CALLS_PER_QUESTION} 次。
			</p>
			{!q.calibratedModels.includes(model.trim()) && <p class="warn">此模型未校准，结果仅供参考</p>}
			<div class="row">
				<button
					type="button"
					class="link"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
					data-testid={`question-${q.id}-prompt-toggle`}
				>
					{open ? "收起题面" : "查看题面"}
				</button>
				<button type="button" class="link" onClick={doCopy} data-testid={`question-${q.id}-copy`}>
					复制题面
				</button>
				<span class="muted" role="status" data-testid={`question-${q.id}-copy-status`}>
					{copy === "copied" ? "已复制" : copy === "failed" ? "复制失败，请手动选中" : ""}
				</span>
			</div>
			{open && (
				<pre class="prompt" data-testid={`question-${q.id}-prompt`}>
					{q.prompt}
				</pre>
			)}
		</li>
	);
}

function Lane({ id, title, attempts }: { id: string; title: string; attempts: Attempt[] }) {
	return (
		<li class="lane" data-testid={`lane-${id}`}>
			<span class="lane-title">{title}</span>
			<ol class="stages">
				{STAGES.map((s, i) => (
					<li class="stage" data-testid={`stage-${i + 1}`} key={i}>
						<span class="muted">
							第 {i + 1} 关 · 需 {s.need}/{s.calls}
						</span>
						<span class="dots">
							{attempts
								.filter((a) => a.stage === i + 1)
								.map((a) => (
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
					</li>
				))}
			</ol>
		</li>
	);
}

function DetailTable({ id, attempts }: { id: string; attempts: Attempt[] }) {
	return (
		<div class="table-wrap">
			<table data-testid={`detail-table-${id}`}>
				<thead>
					<tr>
						<th>关·次·尝试</th>
						<th>结果</th>
						<th>reasoning tokens</th>
						<th>idShape</th>
						<th>TTFT</th>
						<th>总耗时</th>
						<th>回答片段</th>
						<th>缺失数字</th>
					</tr>
				</thead>
				<tbody>
					{attempts.map((a) => {
						const r = a.response?.ok ? a.response : null;
						return (
							<tr key={`${a.stage}-${a.seq}-${a.attempt}`}>
								<td>
									{a.stage}·{a.seq}·{a.attempt}
								</td>
								<td>{resultText(a)}</td>
								<td>{r?.reasoningTokens ?? "—"}</td>
								<td>{r?.idShape ?? "—"}</td>
								<td>{ms(r?.ttftMs)}</td>
								<td>{ms(r?.totalMs)}</td>
								<td class="answer">{r?.answer ?? ""}</td>
								<td>{missingNumbers(a.response)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function Results(props: { run: RunSnapshot; questions: QuestionListItem[]; onRerun: (protocol?: Protocol) => void }) {
	const { run, questions, onRerun } = props;
	const verdicts = questions.map((q) => ({ q, v: evaluateQuestion(ladderCalls(run.attempts, q.id, run.protocol)) }));
	const overall = summarizeRun(verdicts.map(({ v }) => v.status));
	const other: Protocol = run.protocol === "chat" ? "responses" : "chat";
	return (
		<section aria-labelledby="result-h">
			<h2 id="result-h">结果</h2>
			<p class="overall" data-testid="overall-result" data-status={overall}>
				总评：{OVERALL_LABEL[overall]}
				{run.protocol && <span class="muted">（通道 {run.protocol}）</span>}
			</p>
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
			<div class="row">
				<button type="button" onClick={() => onRerun()}>
					再测
				</button>
				{run.protocol && (
					<button type="button" onClick={() => onRerun(other)}>
						也测另一通道（{other}）
					</button>
				)}
			</div>
		</section>
	);
}

function QuestionResult(props: { q: QuestionListItem; v: QuestionVerdict; attempts: Attempt[]; protocol: Protocol | null }) {
	const { q, v, protocol } = props;
	const attempts = props.attempts.filter((a) => a.done && (protocol === null || a.protocol === protocol));
	const advice = v.status === "unavailable" ? failureAdvice(attempts) : null;
	return (
		<article class="verdict" data-testid={`verdict-${q.id}`} data-status={v.status}>
			<h3>
				{q.title}：{VERDICT_LABEL[v.status]}
			</h3>
			<p data-testid={`diagnosis-${q.id}`}>{diagnosis(v, attempts, q.failureHint)}</p>
			{advice && (
				<table class="advice">
					<tbody>
						<tr>
							<th>原因</th>
							<td>{advice.reason}</td>
						</tr>
						<tr>
							<th>下一步</th>
							<td>{advice.next}</td>
						</tr>
					</tbody>
				</table>
			)}
			<DetailTable id={q.id} attempts={attempts} />
		</article>
	);
}

export function App() {
	const [questions, setQuestions] = useState<QuestionListItem[] | null>(null);
	const [loadError, setLoadError] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [site, setSite] = useState("");
	const [key, setKey] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [formError, setFormError] = useState("");
	const [run, setRun] = useState<RunSnapshot | null>(null);
	const [runQuestions, setRunQuestions] = useState<QuestionListItem[]>([]);
	const ctrl = useRef<AbortController | null>(null);
	const keyInput = useRef<HTMLInputElement>(null);
	const running = run !== null && !run.finished;

	useEffect(() => {
		fetchQuestions().then(
			(list) => {
				const ladder = list.filter((q) => q.kind !== "metrics");
				setQuestions(ladder);
				setSelected(ladder.map((q) => q.id));
			},
			(err: unknown) => setLoadError(err instanceof Error ? err.message : "题目加载失败"),
		);
	}, []);

	useEffect(() => {
		if (!running) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		addEventListener("beforeunload", warn);
		return () => removeEventListener("beforeunload", warn);
	}, [running]);

	const start = (protocol?: Protocol) => {
		const chosen = (questions ?? []).filter((q) => selected.includes(q.id));
		if (site.trim() === "" || key === "" || model.trim() === "") {
			setFormError("请填写站点、密钥和模型");
			return;
		}
		setFormError("");
		const controller = new AbortController();
		ctrl.current = controller;
		setRunQuestions(chosen);
		runLadder({
			runId: crypto.randomUUID(),
			questions: chosen.map((q) => q.id),
			probe: makeProbe({ site: site.trim(), key }, model.trim()),
			signal: controller.signal,
			protocol,
			onUpdate: setRun,
		}).catch((err: unknown) => setFormError(err instanceof Error ? err.message : "测试中断"));
	};

	// Switching the type on the DOM node keeps the uncontrolled key input from remounting and losing its value.
	const toggleKey = () => {
		if (keyInput.current) keyInput.current.type = showKey ? "password" : "text";
		setShowKey(!showKey);
	};

	const toggle = (id: string) =>
		setSelected(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

	return (
		<main>
			<header>
				<h1>GPT 降智测试</h1>
				<p>用固定题目多次调用你的中转站，看所买的 GPT 模型是不是原装、有没有被换成弱模型。</p>
				<p class="notice">{PRIVACY}。建议使用有限额的测试密钥。</p>
			</header>

			<section aria-labelledby="questions-h">
				<h2 id="questions-h">选题</h2>
				{loadError && <p class="warn">{loadError}</p>}
				{questions === null && !loadError && <p class="muted">题目加载中…</p>}
				<ul class="questions">
					{(questions ?? []).map((q) => (
						<QuestionRow
							key={q.id}
							q={q}
							checked={selected.includes(q.id)}
							locked={selected.length <= 1}
							model={model}
							onToggle={() => toggle(q.id)}
						/>
					))}
				</ul>
				<p data-testid="cost-line">{costLine(selected.length)}</p>
			</section>

			<section aria-labelledby="form-h">
				<h2 id="form-h">站点与密钥</h2>
				<form
					class="form"
					onSubmit={(e) => {
						e.preventDefault();
						start();
					}}
				>
					<label>
						站点地址
						<input
							type="text"
							inputMode="url"
							placeholder="https://example.com"
							value={site}
							onInput={(e) => setSite(e.currentTarget.value)}
							data-testid="site-input"
						/>
					</label>
					<label>
						密钥
						<span class="row">
							{/* Uncontrolled on purpose: no value prop, so the key never becomes a DOM attribute. */}
							<input
								ref={keyInput}
								type="password"
								autocomplete="off"
								spellcheck={false}
								placeholder="sk-..."
								onInput={(e) => setKey(normalizeKey(e.currentTarget.value))}
								data-testid="key-input"
							/>
							<button type="button" class="link" aria-pressed={showKey} onClick={toggleKey}>
								{showKey ? "隐藏" : "显示"}
							</button>
						</span>
					</label>
					<label>
						模型
						<input value={model} onInput={(e) => setModel(e.currentTarget.value)} data-testid="model-input" />
					</label>
					{formError && (
						<p class="warn" role="alert">
							{formError}
						</p>
					)}
					<div class="row">
						<button type="submit" disabled={running || selected.length === 0} data-testid="start-button">
							开始测试
						</button>
						<button type="button" disabled={!running} onClick={() => ctrl.current?.abort()} data-testid="cancel-button">
							取消
						</button>
					</div>
				</form>
			</section>

			{run && (
				<section aria-labelledby="run-h">
					<h2 id="run-h">运行</h2>
					<p class="muted" aria-live="polite">
						{running ? `进行中${run.protocol ? `，通道 ${run.protocol}` : "，正在探测通道"}` : "已结束"}
					</p>
					<ul class="lanes">
						{runQuestions.map((q) => (
							<Lane key={q.id} id={q.id} title={q.title} attempts={run.attempts.filter((a) => a.question === q.id)} />
						))}
					</ul>
				</section>
			)}

			{run?.finished && <Results run={run} questions={runQuestions} onRerun={start} />}

			<History target={{ site: site.trim(), key }} />
			<Monitor />
			<ApiDocs />
		</main>
	);
}

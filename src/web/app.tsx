import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { STAGES } from "../shared/ladder.ts";
import type { Protocol, QuestionListItem } from "../shared/types.ts";
import { fetchQuestions, makeProbe } from "./api.ts";
import { ApiDocs } from "./docs.tsx";
import { History } from "./history.tsx";
import { Monitor } from "./monitor.tsx";
import { DEFAULT_MODEL, dotLabel, MAX_CALLS_PER_QUESTION } from "./results.ts";
import { Results } from "./result-view.tsx";
import { callState, runLadder, type Attempt, type RunSnapshot } from "./runner.ts";
import { TestForm } from "./test-form.tsx";

const PRIVACY =
	"本站不保存你的密钥。为了对比历史，本站保存站点主机名、测试结果和站点返回的原始响应，最近 10 轮，闲置 90 天后自动删除。凭同一站点和同一密钥可查看或立即删除。密钥只在每次测试时转发给你填写的站点。自定义监测的站点与调用记录只保存在你的浏览器里，密钥不保存。建议使用有限额的测试密钥。";

const KIND_LABEL: Record<QuestionListItem["kind"], string> = { knowledge: "知识", reasoning: "推理", metrics: "度量" };

type CopyStatus = "copied" | "failed";

type ActionsProps = { id: string; open: boolean; copy: CopyStatus | null; onOpen: () => void; onCopy: () => void };

function QuestionActions({ id, open, copy, onOpen, onCopy }: ActionsProps) {
	return (
		<div class="question-actions">
			<button type="button" class="btn-text" aria-expanded={open} onClick={onOpen} data-testid={`question-${id}-prompt-toggle`}>
				{open ? "收起题面" : "查看题面"}
			</button>
			<button type="button" class="btn-text" onClick={onCopy} data-testid={`question-${id}-copy`}>
				复制题面
			</button>
			<span class="muted small" role="status" data-testid={`question-${id}-copy-status`}>
				{copy === "copied" ? "已复制" : copy === "failed" ? "复制失败，请手动选中" : ""}
			</span>
		</div>
	);
}

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
	const calibrated = q.calibratedModels.includes(model.trim());
	return (
		<li class={checked ? "question is-selected" : "question"} data-testid={`question-${q.id}`}>
			<input
				id={`q-${q.id}`}
				type="checkbox"
				checked={checked}
				disabled={checked && locked}
				onChange={onToggle}
				data-testid={`question-${q.id}-toggle`}
			/>
			<div class="question-body">
				<label class="question-head" for={`q-${q.id}`}>
					<span class="question-title">{q.title}</span>
					<span class="tag">{KIND_LABEL[q.kind]}</span>
					<span class="mono muted">v{q.version}</span>
					{!calibrated && <span class="tag tag-warn">此模型未校准，结果仅供参考</span>}
				</label>
				<p>{q.measures}</p>
				<p class="muted small">
					标准答案：{q.expectedLabel}。最多调用 {MAX_CALLS_PER_QUESTION} 次。
				</p>
				<QuestionActions id={q.id} open={open} copy={copy} onOpen={() => setOpen(!open)} onCopy={doCopy} />
				{open && (
					<pre class="prompt" data-testid={`question-${q.id}-prompt`}>
						{q.prompt}
					</pre>
				)}
			</div>
		</li>
	);
}

function Lane({ id, title, attempts }: { id: string; title: string; attempts: Attempt[] }) {
	return (
		<li class="lane" data-testid={`lane-${id}`}>
			<span class="lane-title">{title}</span>
			<ol class="stages">
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
		</li>
	);
}

const DOT_LEGEND = [
	["ok", "答对"],
	["wrong", "答错"],
	["fail", "失败"],
	["pending", "进行中"],
] as const;

const DEFAULT_QUESTION = "thibault";

// Selects the default question alone; a bank without it falls back to every question so the selection is never empty.
const defaultSelection = (ladder: QuestionListItem[]): string[] =>
	ladder.some((q) => q.id === DEFAULT_QUESTION) ? [DEFAULT_QUESTION] : ladder.map((q) => q.id);

function useQuestions() {
	const [questions, setQuestions] = useState<QuestionListItem[] | null>(null);
	const [loadError, setLoadError] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	useEffect(() => {
		fetchQuestions().then(
			(list) => {
				const ladder = list.filter((q) => q.kind !== "metrics");
				setQuestions(ladder);
				setSelected(defaultSelection(ladder));
			},
			(err: unknown) => setLoadError(err instanceof Error ? err.message : "题目加载失败"),
		);
	}, []);
	const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
	return { questions, loadError, selected, toggle };
}

type QuestionsProps = { questions: QuestionListItem[] | null; loadError: string; selected: string[]; model: string; onToggle: (id: string) => void };

function QuestionsSection({ questions, loadError, selected, model, onToggle }: QuestionsProps) {
	return (
		<section class="block col-12 col-lg-7" aria-labelledby="questions-h">
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
						onToggle={() => onToggle(q.id)}
					/>
				))}
			</ul>
		</section>
	);
}

function RunSection({ run, running, questions }: { run: RunSnapshot; running: boolean; questions: QuestionListItem[] }) {
	return (
		<section class="block col-12" aria-labelledby="run-h">
			<div class="section-head">
				<h2 id="run-h">运行</h2>
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
			<ul class="lanes">
				{questions.map((q) => (
					<Lane key={q.id} id={q.id} title={q.title} attempts={run.attempts.filter((a) => a.question === q.id)} />
				))}
			</ul>
		</section>
	);
}

function SiteHeader() {
	return (
		<header class="site-header">
			<div>
				<h1>GPT 降智测试</h1>
				<p class="lead">用固定题目调用你的站点，检查它返回的是不是你购买的 GPT 模型，有没有换成较弱的模型。</p>
			</div>
			<nav class="site-nav" aria-label="页内导航">
				<a href="#monitor">监测</a>
				<a href="#history">历史</a>
				<a href="#api-docs">API 说明</a>
			</nav>
		</header>
	);
}

type RunInput = { site: string; key: string; model: string; questions: QuestionListItem[] | null; selected: string[] };

function useLadderRun({ site, key, model, questions, selected }: RunInput) {
	const [run, setRun] = useState<RunSnapshot | null>(null);
	const [runQuestions, setRunQuestions] = useState<QuestionListItem[]>([]);
	const [formError, setFormError] = useState("");
	const ctrl = useRef<AbortController | null>(null);
	const running = run !== null && !run.finished;

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
	return { run, runQuestions, running, formError, start, cancel: () => ctrl.current?.abort() };
}

export function App() {
	const q = useQuestions();
	const [site, setSite] = useState("");
	const [key, setKey] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const r = useLadderRun({ site, key, model, questions: q.questions, selected: q.selected });
	const monitorIds = useMemo(() => (q.questions ?? []).map((x) => x.id).sort(), [q.questions]);
	const formProps = { site, setSite, setKey, model, setModel, running: r.running, selectedCount: q.selected.length, error: r.formError };

	return (
		<div class="container">
			<SiteHeader />
			<Monitor questionIds={monitorIds} />
			<p class="privacy">
				<strong>隐私</strong>
				<span>{PRIVACY}</span>
			</p>
			<main class="grid main-grid">
				<QuestionsSection questions={q.questions} loadError={q.loadError} selected={q.selected} model={model} onToggle={q.toggle} />
				<TestForm {...formProps} onStart={() => r.start()} onCancel={r.cancel} />
				{r.run && <RunSection run={r.run} running={r.running} questions={r.runQuestions} />}
				{r.run?.finished && <Results run={r.run} questions={r.runQuestions} onRerun={r.start} />}
				<History target={{ site: site.trim(), key }} />
				<ApiDocs />
			</main>
			<footer class="site-footer">
				<span>GPT 降智测试</span>
				<span>不保存密钥 · 结果只代表测试当时的站点表现</span>
			</footer>
		</div>
	);
}

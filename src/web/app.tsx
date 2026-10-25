import { useEffect, useRef, useState } from "preact/hooks";
import type { GeneratorId, Protocol, QuestionListItem } from "../shared/types.ts";
import { fetchQuestions, makeProbe, missingFields, type Target } from "./api.ts";
import { CustomQuestionForm } from "./custom-question.tsx";
import { ApiDocs } from "./docs.tsx";
import { History } from "./history.tsx";
import { DEFAULT_MODEL } from "./results.ts";
import { Results } from "./result-view.tsx";
import { runLadder, type RunSnapshot } from "./runner.ts";
import { TestForm } from "./test-form.tsx";
import { WatchBoard } from "./watch-board.tsx";

const PRIVACY = [
	["密钥", "实时测试不保存密钥。密钥只在每次测试时转发给你填写的站点。持续监测在你同意后加密保存密钥，仅用于服务器定时调用。"],
	["保存的内容", "站点主机名、测试结果和站点返回的原始响应，最近 10 轮。"],
	["删除", "闲置 90 天后自动删除。凭同一站点和同一密钥可查看，也可立即删除。"],
	["持续监测", "密钥加密后存在服务器，凭页面保存的令牌读取与删除。闲置 7 天无人查看自动删除。"],
] as const;

const GENERATOR_HINT: Record<GeneratorId, string> = {
	candy: "每轮的物品、属性和数字都会变，下面是一个示例。",
	pelican: "每轮的动物和交通工具都会变，下面是一个示例。",
};
const KIND_LABEL: Record<QuestionListItem["kind"], string> = { knowledge: "知识", reasoning: "推理", metrics: "度量" };

type CopyStatus = "copied" | "failed";

function QuestionRow(props: { q: QuestionListItem; checked: boolean; model: string; onToggle: () => void }) {
	const { q, checked, model, onToggle } = props;
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
	const generated = q.generator !== undefined;
	const noun = generated ? "示例题面" : "题面";
	return (
		<li class={checked ? "question is-selected" : "question"} data-testid={`question-${q.id}`}>
			<input
				id={`q-${q.id}`}
				type="checkbox"
				checked={checked}
				onChange={onToggle}
				data-testid={`question-${q.id}-toggle`}
			/>
			<div class="question-body">
				<label class="question-head" for={`q-${q.id}`}>
					<span class="question-title">{q.title}</span>
					<span class="tag">{KIND_LABEL[q.kind]}</span>
					{generated && <span class="tag">每轮随机生成</span>}
					<span class="mono muted">v{q.version}</span>
					{q.calibratedModels.length > 0 && !calibrated && <span class="tag tag-warn">此模型未校准，结果仅供参考</span>}
				</label>
				<p>{q.measures}</p>
				<button type="button" class="btn-text" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={`question-${q.id}-prompt-toggle`}>
					{open ? `收起${noun}` : `查看${noun}`}
				</button>
				{open && (
					<>
						<pre class="prompt" data-testid={`question-${q.id}-prompt`}>
							{q.prompt}
						</pre>
						<p class="muted small">标准答案：{q.expectedLabel}。</p>
						{q.generator && <p class="muted small">{GENERATOR_HINT[q.generator]}</p>}
						<div class="question-actions">
							<button type="button" class="btn-text" onClick={doCopy} data-testid={`question-${q.id}-copy`}>
								复制{noun}
							</button>
							<span class="muted small" role="status" data-testid={`question-${q.id}-copy-status`}>
								{copy === "copied" ? "已复制" : copy === "failed" ? "复制失败，请手动选中" : ""}
							</span>
						</div>
					</>
				)}
			</div>
		</li>
	);
}

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

type QuestionsProps = {
	questions: QuestionListItem[] | null;
	loadError: string;
	selected: string[];
	model: string;
	target: Target;
	onToggle: (id: string) => void;
};

function QuestionsSection({ questions, loadError, selected, model, target, onToggle }: QuestionsProps) {
	const [customOpen, setCustomOpen] = useState(false);
	return (
		<section class="block col-12" aria-labelledby="questions-h">
			<div class="section-head">
				<h2 id="questions-h">选题</h2>
				<div class="section-tools">
					<button
						type="button"
						class="btn btn-secondary"
						aria-expanded={customOpen}
						onClick={() => setCustomOpen(!customOpen)}
						data-testid="custom-q-toggle"
					>
						自定义题
					</button>
				</div>
			</div>
			{loadError && <p class="warn">{loadError}</p>}
			{questions === null && !loadError && <p class="muted">题目加载中…</p>}
			{questions !== null && questions.some((q) => !q.calibratedModels.includes(model.trim())) && (
				<p class="muted small">题目尚未按当前模型校准，结果仅供参考。</p>
			)}
			<ul class="questions">
				{(questions ?? []).map((q) => (
					<QuestionRow
						key={q.id}
						q={q}
						checked={selected.includes(q.id)}
						model={model}
						onToggle={() => onToggle(q.id)}
					/>
				))}
			</ul>
			{customOpen && <CustomQuestionForm target={target} model={model} />}
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
		</header>
	);
}

type TabId = "live" | "watch";

// The hash routes between tabs; #live is the default so an unknown hash still lands on the live test.
function useTab(): [TabId, (tab: TabId) => void] {
	const read = (): TabId => (location.hash === "#watch" || location.hash.startsWith("#watch/") ? "watch" : "live");
	const [tab, setTab] = useState<TabId>(read);
	useEffect(() => {
		const onHash = () => setTab(read());
		addEventListener("hashchange", onHash);
		return () => removeEventListener("hashchange", onHash);
	}, []);
	return [tab, (next) => {
		location.hash = next === "live" ? "#live" : "#watch";
	}];
}

function Tabs({ tab, onSwitch }: { tab: TabId; onSwitch: (tab: TabId) => void }) {
	const tabs: [TabId, string][] = [
		["live", "实时测试"],
		["watch", "持续监测"],
	];
	return (
		<div class="tabs" role="tablist" aria-label="测试方式">
			{tabs.map(([id, label]) => (
				<button
					type="button"
					role="tab"
					id={`tab-${id}`}
					aria-selected={tab === id}
					aria-controls={id === "live" ? "live-pane" : "watch-pane"}
					class={tab === id ? "tab is-active" : "tab"}
					onClick={() => onSwitch(id)}
					data-testid={`tab-${id}`}
					key={id}
				>
					{label}
				</button>
			))}
		</div>
	);
}

type RunInput = { site: string; key: string; model: string; questions: QuestionListItem[] | null; selected: string[] };

function useLadderRun({ site, key, model, questions, selected }: RunInput) {
	const [run, setRun] = useState<RunSnapshot | null>(null);
	const [runQuestions, setRunQuestions] = useState<QuestionListItem[]>([]);
	const [runSeed, setRunSeed] = useState(0);
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
		const missing = missingFields({ site, key }, model);
		if (missing.length > 0) {
			setFormError(`请填写${missing.join("、")}`);
			return;
		}
		setFormError("");
		const controller = new AbortController();
		ctrl.current = controller;
		const seed = crypto.getRandomValues(new Uint32Array(1))[0];
		setRunQuestions(chosen);
		setRunSeed(seed);
		runLadder({
			runId: crypto.randomUUID(),
			questions: chosen.map((q) => q.id),
			probe: makeProbe({ site: site.trim(), key }, model.trim(), seed),
			signal: controller.signal,
			protocol,
			onUpdate: setRun,
		}).catch((err: unknown) => setFormError(err instanceof Error ? err.message : "测试中断"));
	};
	return { run, runQuestions, runSeed, running, formError, start, cancel: () => ctrl.current?.abort() };
}

export function App() {
	const q = useQuestions();
	const [site, setSite] = useState("");
	const [key, setKey] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const r = useLadderRun({ site, key, model, questions: q.questions, selected: q.selected });
	const [tab, switchTab] = useTab();
	const formProps = { site, setSite, setKey, model, setModel, running: r.running, selectedCount: q.selected.length, error: r.formError };

	useEffect(() => {
		if (r.run !== null) document.getElementById("results")?.scrollIntoView({ block: "start" });
	}, [r.run !== null]);

	return (
		<div class="container">
			<SiteHeader />
			<Tabs tab={tab} onSwitch={switchTab} />
			{tab === "live" ? (
				<div id="live-pane" role="tabpanel" aria-labelledby="tab-live">
					<details class="privacy">
						<summary>实时测试不保存密钥，只在每次调用时转发给站点。请使用有限额的密钥。详情</summary>
						<dl>
							{PRIVACY.map(([term, text]) => (
								<div key={term}>
									<dt>{term}</dt>
									<dd>{text}</dd>
								</div>
							))}
						</dl>
					</details>
					<main class="grid main-grid">
						<TestForm {...formProps} onStart={() => r.start()} onCancel={r.cancel} />
						{r.run && <Results run={r.run} running={r.running} questions={r.runQuestions} seed={r.runSeed} onRerun={r.start} />}
						<QuestionsSection questions={q.questions} loadError={q.loadError} selected={q.selected} model={model} target={{ site: site.trim(), key }} onToggle={q.toggle} />
						<History target={{ site: site.trim(), key }} />
						<ApiDocs />
					</main>
				</div>
			) : (
				<div id="watch-pane" role="tabpanel" aria-labelledby="tab-watch">
					<WatchBoard />
				</div>
			)}
			<footer class="site-footer">
				<span>GPT 降智测试</span>
				<span>实时测试不保存密钥 · 结果只代表测试当时的站点表现</span>
			</footer>
		</div>
	);
}

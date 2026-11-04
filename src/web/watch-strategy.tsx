import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { QuestionListItem } from "../shared/types.ts";
import { dailyCalls, matchStrategy, measureDailyCalls, measureEveryRounds, WATCH_INTERVALS, WATCH_STRATEGIES, type WatchIntervalMin, type WatchStrategy } from "../shared/watch.ts";
import { fetchQuestions } from "./api.ts";

export function ChoiceField<T extends string | number>(props: {
	label: string;
	testId: string;
	value: T;
	options: readonly T[];
	text: (v: T) => string;
	onChange: (v: T) => void;
	class?: string;
}) {
	return (
		<label class={`field ${props.class ?? "col-12 col-md-6 col-lg-4"}`}>
			<span class="field-label">{props.label}</span>
			<select
				value={String(props.value)}
				onChange={(e) => props.onChange(props.options.find((o) => String(o) === e.currentTarget.value) ?? props.options[0]!)}
				data-testid={props.testId}
			>
				{props.options.map((o) => (
					<option value={String(o)} key={String(o)}>
						{props.text(o)}
					</option>
				))}
			</select>
		</label>
	);
}

function useWatchQuestions(initial: readonly string[]) {
	const [questions, setQuestions] = useState<QuestionListItem[] | null>(null);
	const [loadError, setLoadError] = useState("");
	const [picked, setPicked] = useState<string[]>(() => [...initial]);
	useEffect(() => {
		fetchQuestions().then(
			(list) => setQuestions(list.filter((q) => q.inWatchRotation !== false)),
			(err: unknown) => setLoadError(err instanceof Error ? err.message : "题目加载失败"),
		);
	}, []);
	const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((p) => p !== id) : [...current, id]));
	return { questions, loadError, picked, setPicked, toggle };
}

function QuestionPicks(props: ReturnType<typeof useWatchQuestions> & { testPrefix: string; children?: ComponentChildren }) {
	return (
		<fieldset class="field col-12 question-picks">
			<legend class="field-label">题目</legend>
			{props.loadError && <p class="warn">{props.loadError}</p>}
			{props.questions === null && !props.loadError && <p class="muted small">题目加载中…</p>}
			<div class="question-pick-list">
				{(props.questions ?? []).map((q) => (
					<label class="consent-row" key={q.id}>
						<input type="checkbox" checked={props.picked.includes(q.id)} onChange={() => props.toggle(q.id)} data-testid={`${props.testPrefix}-question-${q.id}`} />
						<span>
							{q.title} <span class="mono muted">{q.id}</span>
						</span>
					</label>
				))}
			</div>
			<p class="muted small">每次调用按顺序换下一道选中的题。</p>
			{props.children}
		</fieldset>
	);
}

export const DEFAULT_STRATEGY = WATCH_STRATEGIES[0]!;

export function useWatchStrategy<I extends number = WatchIntervalMin>(initial: { intervalMin: I | WatchIntervalMin; questions: readonly string[]; measure: boolean }) {
	const questions = useWatchQuestions(initial.questions);
	const [intervalMin, setIntervalMin] = useState<I | WatchIntervalMin>(initial.intervalMin);
	const [measure, setMeasure] = useState(initial.measure);
	const [custom, setCustom] = useState(() => matchStrategy(initial) === undefined);
	const choose = (strategy: WatchStrategy | null) => {
		setCustom(strategy === null);
		if (!strategy) return;
		setIntervalMin(strategy.intervalMin);
		setMeasure(strategy.measure);
		questions.setPicked([...strategy.questions]);
	};
	// A watch on a retired interval lists it too, so saving a question edit does not move it to another interval.
	const intervals = [...new Set<I | WatchIntervalMin>([...WATCH_INTERVALS, initial.intervalMin])].sort((a, b) => a - b);
	return { questions, intervalMin, setIntervalMin, measure, setMeasure, intervals, custom, choose };
}

type FieldsProps<I extends number> = { testPrefix: string; strategy: ReturnType<typeof useWatchStrategy<I>>; children?: ComponentChildren };

export function WatchStrategyFields<I extends number>({ testPrefix: t, strategy, children }: FieldsProps<I>) {
	const { questions, intervalMin, setIntervalMin, measure, setMeasure, intervals, custom, choose } = strategy;
	const active = custom ? undefined : matchStrategy({ intervalMin, questions: questions.picked, measure });
	return (
		<fieldset class="field col-12 strategy-picks">
			<legend class="field-label">监测策略</legend>
			<div class="strategy-list">
				{WATCH_STRATEGIES.map((s) => (
					<label class="consent-row" key={s.id}>
						<input type="radio" name={`${t}-strategy`} checked={active?.id === s.id} onChange={() => choose(s)} data-testid={`${t}-strategy-${s.id}`} />
						<span>
							<span class="strategy-name">{s.label}</span> {s.answers}
							<span class="muted small strategy-detail">
								每 {s.intervalMin} 分钟，每天 {dailyCalls(s)} 次调用。{s.note}
							</span>
						</span>
					</label>
				))}
				<label class="consent-row">
					<input type="radio" name={`${t}-strategy`} checked={custom} onChange={() => choose(null)} data-testid={`${t}-strategy-custom`} />
					<span>
						<span class="strategy-name">自定义</span> 自己选间隔和题目。
					</span>
				</label>
			</div>
			<p class="muted small">每天调用次数不含失败后的重试。</p>
			{custom && (
				<div class="grid strategy-custom">
					<ChoiceField label="间隔" testId={`${t}-interval`} value={intervalMin} options={intervals} text={(i) => `每 ${i} 分钟`} onChange={setIntervalMin} class="col-12" />
					<QuestionPicks {...questions} testPrefix={t}>
						{children}
					</QuestionPicks>
					<div class="field col-12">
						<label class="consent-row">
							<input type="checkbox" checked={measure} onChange={(e) => setMeasure(e.currentTarget.checked)} data-testid={`${t}-measure`} />
							<span>同时测缓存命中率和输出速度</span>
						</label>
						<p class="muted small">
							每 {measureEveryRounds(intervalMin)} 轮测一次，约每 3 小时。每天多 {measureDailyCalls(intervalMin)} 次调用，按题面估算约多用 8 万 token，不含站点额外加的输入，消耗这把密钥的额度。
						</p>
					</div>
				</div>
			)}
		</fieldset>
	);
}

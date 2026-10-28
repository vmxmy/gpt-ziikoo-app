import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, RefObject } from "preact";
import type { Protocol, QuestionListItem } from "../shared/types.ts";
import { WATCH_IDLE_DAYS, WATCH_INTERVALS, WATCH_MAX_ALIAS, type WatchIntervalMin } from "../shared/watch.ts";
import { fetchQuestions } from "./api.ts";
import { ModelField } from "./model-field.tsx";
import { DEFAULT_MODEL, normalizeKey } from "./results.ts";
import { SecretInput } from "./test-form.tsx";
import { protocolForModel, PROTOCOLS, type FieldError, type WatchInput } from "./watch.ts";

const ERROR_ID = "watch-add-error";

function FieldMessage({ error, field }: { error: FieldError | null; field: FieldError["field"] }) {
	if (error?.field !== field) return null;
	return (
		<p class="field-error" id={ERROR_ID} role="alert" data-testid="watch-add-error">
			{error.message}
		</p>
	);
}

const invalid = (error: FieldError | null, field: FieldError["field"]) =>
	error?.field === field ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

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

function SiteField(props: { inputRef: RefObject<HTMLInputElement | null>; value: string; onInput: (v: string) => void; error: FieldError | null }) {
	return (
		<label class="field col-12 col-md-6 col-lg-4">
			<span class="field-label">站点地址</span>
			<input
				ref={props.inputRef}
				type="text"
				inputMode="url"
				autocomplete="username"
				placeholder="https://example.com"
				value={props.value}
				onInput={(e) => props.onInput(e.currentTarget.value)}
				data-testid="watch-add-site"
				{...invalid(props.error, "site")}
			/>
			<FieldMessage error={props.error} field="site" />
		</label>
	);
}

// A new watch starts with every question picked; an edit starts from the watch's own picks.
export function useWatchQuestions(initial?: readonly string[]) {
	const [questions, setQuestions] = useState<QuestionListItem[] | null>(null);
	const [loadError, setLoadError] = useState("");
	const [picked, setPicked] = useState<string[]>(() => [...(initial ?? [])]);
	useEffect(() => {
		fetchQuestions().then(
			(list) => {
				const rotation = list.filter((q) => q.inWatchRotation !== false);
				setQuestions(rotation);
				if (!initial) setPicked(rotation.map((q) => q.id));
			},
			(err: unknown) => setLoadError(err instanceof Error ? err.message : "题目加载失败"),
		);
	}, []);
	const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((p) => p !== id) : [...current, id]));
	return { questions, loadError, picked, toggle };
}

export function QuestionPicks(props: ReturnType<typeof useWatchQuestions> & { testPrefix: string; children?: ComponentChildren }) {
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

const CONSENT_TEXT = "我同意本站加密保存这把密钥，并由本站服务器按所选间隔持续调用该站点。";

export function WatchAddForm({ onAdd, onClose }: { onAdd: (input: WatchInput) => Promise<FieldError | null>; onClose: () => void }) {
	const [site, setSite] = useState("");
	// State only feeds the model-list target; the submit still reads the ref, and the key never enters storage or logs.
	const [key, setKey] = useState("");
	const [alias, setAlias] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [intervalMin, setIntervalMin] = useState<WatchIntervalMin>(5);
	const [protocol, setProtocol] = useState<Protocol>("responses");
	const watchQuestions = useWatchQuestions();
	const [consent, setConsent] = useState(false);
	const [error, setError] = useState<FieldError | null>(null);
	const [busy, setBusy] = useState(false);
	const siteInput = useRef<HTMLInputElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);

	useEffect(() => siteInput.current?.focus(), []);

	const chooseModel = (next: string) => {
		setModel(next);
		setProtocol((current) => protocolForModel(next, current));
	};

	const submit = async () => {
		setBusy(true);
		setError(null);
		const result = await onAdd({
			site,
			alias,
			key: keyInput.current?.value ?? "",
			model,
			protocol,
			intervalMin,
			questions: watchQuestions.picked,
			consent,
		});
		setBusy(false);
		if (result) return setError(result);
		if (keyInput.current) keyInput.current.value = "";
		onClose();
	};

	return (
		<form
			class="panel add-form grid"
			id="watch-add"
			data-testid="watch-add-form"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<SiteField inputRef={siteInput} value={site} onInput={setSite} error={error} />
			<label class="field col-12 col-md-6 col-lg-4">
				<span class="field-label">密钥</span>
				<SecretInput inputRef={keyInput} testId="watch-add-key" onInput={(v) => setKey(normalizeKey(v))} invalid={error?.field === "key"} describedBy={ERROR_ID} />
				<p class="muted small">提交后由本站加密保存，关闭页面监测继续。请使用有限额的密钥。</p>
				<FieldMessage error={error} field="key" />
			</label>
			<label class="field col-12 col-md-6 col-lg-4">
				<span class="field-label">别名（可选）</span>
				<input
					value={alias}
					maxLength={WATCH_MAX_ALIAS}
					placeholder="区分同一站点的不同通道"
					autocomplete="off"
					onInput={(e) => setAlias(e.currentTarget.value)}
					data-testid="watch-add-alias"
				/>
			</label>
			<ModelField
				value={model}
				onInput={chooseModel}
				target={{ site: site.trim(), key }}
				testId="watch-add-model"
				class="col-12 col-md-6 col-lg-4"
				invalid={error?.field === "model"}
				describedBy={ERROR_ID}
			/>
			<FieldMessage error={error} field="model" />
			<ChoiceField label="协议" testId="watch-add-protocol" value={protocol} options={PROTOCOLS} text={(p) => p} onChange={setProtocol} />
			<ChoiceField label="间隔" testId="watch-add-interval" value={intervalMin} options={WATCH_INTERVALS} text={(i) => `每 ${i} 分钟`} onChange={setIntervalMin} />
			<QuestionPicks {...watchQuestions} testPrefix="watch-add">
				<FieldMessage error={error} field="questions" />
			</QuestionPicks>
			<div class="field col-12">
				<label class="consent-row">
					<input type="checkbox" checked={consent} onChange={(e) => setConsent(e.currentTarget.checked)} data-testid="watch-add-consent" />
					<span>{CONSENT_TEXT}</span>
				</label>
				<FieldMessage error={error} field="consent" />
			</div>
			<div class="form-foot col-12">
				<p class="muted">监测由本站服务器执行。闲置 {WATCH_IDLE_DAYS} 天后自动删除，删除卡片会立即清空密钥与样本。</p>
				<div class="actions">
					<button type="button" class="btn btn-secondary" onClick={onClose}>
						取消
					</button>
					<button type="submit" class="btn btn-primary" disabled={busy || watchQuestions.questions === null} data-testid="watch-add-submit">
						{busy ? "正在验证…" : "添加持续监测"}
					</button>
				</div>
			</div>
			<FieldMessage error={error} field="form" />
		</form>
	);
}

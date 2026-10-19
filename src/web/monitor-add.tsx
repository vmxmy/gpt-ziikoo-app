import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import type { Protocol } from "../shared/types.ts";
import { INTERVALS, MAX_ALIAS, PROTOCOLS, type IntervalMin } from "./custom-monitor.ts";
import { DEFAULT_MODEL } from "./results.ts";
import { SecretInput } from "./test-form.tsx";

export type AddInput = { site: string; alias: string; key: string; model: string; protocol: Protocol; intervalMin: IntervalMin };
export type FieldError = { field: "site" | "key" | "model"; message: string };

const ERROR_ID = "monitor-add-error";

function FieldMessage({ error, field }: { error: FieldError | null; field: FieldError["field"] }) {
	if (error?.field !== field) return null;
	return (
		<p class="field-error" id={ERROR_ID} role="alert" data-testid="monitor-add-error">
			{error.message}
		</p>
	);
}

const invalid = (error: FieldError | null, field: FieldError["field"]) =>
	error?.field === field ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

function ChoiceField<T extends string | number>(props: { label: string; testId: string; value: T; options: readonly T[]; text: (v: T) => string; onChange: (v: T) => void }) {
	return (
		<label class="field col-6 col-lg-2">
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
		<label class="field col-12 col-md-6 col-lg-3">
			<span class="field-label">站点地址</span>
			<input
				ref={props.inputRef}
				type="text"
				inputMode="url"
				autocomplete="username"
				placeholder="https://example.com"
				value={props.value}
				onInput={(e) => props.onInput(e.currentTarget.value)}
				data-testid="monitor-add-site"
				{...invalid(props.error, "site")}
			/>
			<FieldMessage error={props.error} field="site" />
		</label>
	);
}

function FormFoot({ busy, ready, onClose }: { busy: boolean; ready: boolean; onClose: () => void }) {
	return (
		<div class="form-foot col-12">
			<p class="muted">{ready ? "关闭页面后监测暂停。本站不保存密钥。站点与调用记录只保存在本浏览器。" : "题目加载中，加载完成后即可添加。"}</p>
			<div class="actions">
				<button type="button" class="btn btn-secondary" onClick={onClose}>
					取消
				</button>
				<button type="submit" class="btn btn-primary" disabled={busy || !ready} data-testid="monitor-add-submit">
					{busy ? "正在验证…" : "添加并开始监测"}
				</button>
			</div>
		</div>
	);
}

export function AddSiteForm({ ready, onAdd, onClose }: { ready: boolean; onAdd: (input: AddInput) => Promise<FieldError | null>; onClose: () => void }) {
	const [site, setSite] = useState("");
	const [alias, setAlias] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [intervalMin, setIntervalMin] = useState<IntervalMin>(1);
	const [protocol, setProtocol] = useState<Protocol>("responses");
	const [error, setError] = useState<FieldError | null>(null);
	const [busy, setBusy] = useState(false);
	const siteInput = useRef<HTMLInputElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);

	useEffect(() => siteInput.current?.focus(), []);

	const submit = async () => {
		setBusy(true);
		setError(null);
		const result = await onAdd({ site, alias, key: keyInput.current?.value ?? "", model, protocol, intervalMin });
		setBusy(false);
		if (result) return setError(result);
		if (keyInput.current) keyInput.current.value = "";
		onClose();
	};

	return (
		<form
			class="panel add-form grid"
			id="monitor-add"
			data-testid="monitor-add-form"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<SiteField inputRef={siteInput} value={site} onInput={setSite} error={error} />
			<label class="field col-12 col-md-6 col-lg-3">
				<span class="field-label">密钥</span>
				<SecretInput inputRef={keyInput} testId="monitor-add-key" invalid={error?.field === "key"} describedBy={ERROR_ID} />
				<p class="muted small">本站不保存密钥，只在页面打开期间放在内存里。请使用有限额的密钥。</p>
				<FieldMessage error={error} field="key" />
			</label>
			<label class="field col-6 col-lg-2">
				<span class="field-label">模型</span>
				<input value={model} onInput={(e) => setModel(e.currentTarget.value)} data-testid="monitor-add-model" {...invalid(error, "model")} />
				<FieldMessage error={error} field="model" />
			</label>
			<ChoiceField label="协议" testId="monitor-add-protocol" value={protocol} options={PROTOCOLS} text={(p) => p} onChange={setProtocol} />
			<ChoiceField label="间隔" testId="monitor-add-interval" value={intervalMin} options={INTERVALS} text={(i) => `每 ${i} 分钟`} onChange={setIntervalMin} />
			<label class="field col-12 col-md-6 col-lg-3">
				<span class="field-label">别名（可选）</span>
				<input
					value={alias}
					maxLength={MAX_ALIAS}
					placeholder="区分同一站点的不同通道"
					autocomplete="off"
					onInput={(e) => setAlias(e.currentTarget.value)}
					data-testid="monitor-add-alias"
				/>
			</label>
			<FormFoot busy={busy} ready={ready} onClose={onClose} />
		</form>
	);
}

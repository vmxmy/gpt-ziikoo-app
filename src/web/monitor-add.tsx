import { useEffect, useRef, useState } from "preact/hooks";
import { INTERVALS, type IntervalMin } from "./custom-monitor.ts";
import { DEFAULT_MODEL } from "./results.ts";
import { SecretInput } from "./test-form.tsx";

export type AddInput = { site: string; key: string; model: string; intervalMin: IntervalMin };
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

function IntervalField({ value, onChange }: { value: IntervalMin; onChange: (v: IntervalMin) => void }) {
	return (
		<label class="field col-6 col-lg-2">
			<span class="field-label">间隔</span>
			<select value={value} onChange={(e) => onChange(INTERVALS.find((i) => i === Number(e.currentTarget.value)) ?? 1)} data-testid="monitor-add-interval">
				{INTERVALS.map((i) => (
					<option value={i} key={i}>
						每 {i} 分钟
					</option>
				))}
			</select>
		</label>
	);
}

function FormFoot({ busy, onClose }: { busy: boolean; onClose: () => void }) {
	return (
		<div class="form-foot col-12">
			<p class="muted">关闭页面后监测暂停。密钥不会被保存。站点与样本只保存在本浏览器。</p>
			<div class="actions">
				<button type="button" class="btn btn-secondary" onClick={onClose}>
					取消
				</button>
				<button type="submit" class="btn btn-primary" disabled={busy} data-testid="monitor-add-submit">
					{busy ? "正在验证…" : "添加并开始监测"}
				</button>
			</div>
		</div>
	);
}

export function AddSiteForm({ onAdd, onClose }: { onAdd: (input: AddInput) => Promise<FieldError | null>; onClose: () => void }) {
	const [site, setSite] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [intervalMin, setIntervalMin] = useState<IntervalMin>(1);
	const [error, setError] = useState<FieldError | null>(null);
	const [busy, setBusy] = useState(false);
	const siteInput = useRef<HTMLInputElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);

	useEffect(() => siteInput.current?.focus(), []);

	const submit = async () => {
		setBusy(true);
		setError(null);
		const result = await onAdd({ site, key: keyInput.current?.value ?? "", model, intervalMin });
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
			<label class="field col-12 col-md-6 col-lg-5">
				<span class="field-label">站点地址</span>
				<input
					ref={siteInput}
					type="text"
					inputMode="url"
					placeholder="https://example.com"
					value={site}
					onInput={(e) => setSite(e.currentTarget.value)}
					data-testid="monitor-add-site"
					{...invalid(error, "site")}
				/>
				<FieldMessage error={error} field="site" />
			</label>
			<label class="field col-12 col-md-6 col-lg-3">
				<span class="field-label">密钥</span>
				<SecretInput inputRef={keyInput} testId="monitor-add-key" invalid={error?.field === "key"} describedBy={ERROR_ID} />
				<FieldMessage error={error} field="key" />
			</label>
			<label class="field col-6 col-lg-2">
				<span class="field-label">模型</span>
				<input value={model} onInput={(e) => setModel(e.currentTarget.value)} data-testid="monitor-add-model" {...invalid(error, "model")} />
				<FieldMessage error={error} field="model" />
			</label>
			<IntervalField value={intervalMin} onChange={setIntervalMin} />
			<FormFoot busy={busy} onClose={onClose} />
		</form>
	);
}

import type { RefObject } from "preact";
import { useRef, useState } from "preact/hooks";
import { costLine, normalizeKey } from "./results.ts";

type Props = {
	site: string;
	setSite: (v: string) => void;
	setKey: (v: string) => void;
	model: string;
	setModel: (v: string) => void;
	running: boolean;
	selectedCount: number;
	error: string;
	onStart: () => void;
	onCancel: () => void;
};

type SecretProps = {
	inputRef: RefObject<HTMLInputElement | null>;
	testId: string;
	onInput?: (value: string) => void;
	invalid?: boolean;
	describedBy?: string;
};

export function SecretInput({ inputRef, testId, onInput, invalid, describedBy }: SecretProps) {
	const [shown, setShown] = useState(false);
	// Switching the type on the DOM node keeps the uncontrolled key input from remounting and losing its value.
	const toggle = () => {
		if (inputRef.current) inputRef.current.type = shown ? "password" : "text";
		setShown(!shown);
	};
	return (
		<span class="affix">
			{/* Uncontrolled on purpose: no value prop, so the key never becomes a DOM attribute. */}
			<input
				ref={inputRef}
				type="password"
				autocomplete="current-password"
				spellcheck={false}
				placeholder="sk-..."
				onInput={onInput && ((e) => onInput(e.currentTarget.value))}
				aria-invalid={invalid || undefined}
				aria-describedby={invalid ? describedBy : undefined}
				data-testid={testId}
			/>
			<button type="button" class="btn-text" aria-pressed={shown} onClick={toggle}>
				{shown ? "隐藏" : "显示"}
			</button>
		</span>
	);
}

function FormActions(props: Props) {
	return (
		<>
			<div class="actions">
				<button type="submit" class="btn btn-primary" disabled={props.running || props.selectedCount === 0} data-testid="start-button">
					开始测试
				</button>
				<button type="button" class="btn btn-secondary" disabled={!props.running} onClick={props.onCancel} data-testid="cancel-button">
					取消
				</button>
			</div>
			<p class="muted small" data-testid="cost-line">
				{costLine(props.selectedCount)}
			</p>
		</>
	);
}

export function TestForm(props: Props) {
	const keyInput = useRef<HTMLInputElement>(null);

	return (
		<section class="panel col-12 col-lg-5" aria-labelledby="form-h">
			<h2 id="form-h">站点与密钥</h2>
			<form
				class="form"
				onSubmit={(e) => {
					e.preventDefault();
					props.onStart();
				}}
			>
				<label class="field">
					<span class="field-label">站点地址</span>
					<input
						type="text"
						inputMode="url"
						autocomplete="username"
						placeholder="https://example.com"
						value={props.site}
						onInput={(e) => props.setSite(e.currentTarget.value)}
						data-testid="site-input"
					/>
				</label>
				<label class="field">
					<span class="field-label">密钥</span>
					<SecretInput inputRef={keyInput} testId="key-input" onInput={(v) => props.setKey(normalizeKey(v))} />
					<p class="muted small">密钥只在本次测试时转发给站点，不保存。请使用有限额的密钥。</p>
				</label>
				<label class="field">
					<span class="field-label">模型</span>
					<input value={props.model} onInput={(e) => props.setModel(e.currentTarget.value)} data-testid="model-input" />
				</label>
				{props.error && (
					<p class="field-error" role="alert">
						{props.error}
					</p>
				)}
				<FormActions {...props} />
			</form>
		</section>
	);
}

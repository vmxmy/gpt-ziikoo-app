import { useRef, useState, type RefObject } from "react";
import { ModelField, type ModelList } from "./model-field.tsx";
import { privateInputClass, usePrivacy } from "./privacy.ts";
import { costLine, normalizeKey } from "./results.ts";

type Props = {
	model: string;
	setModel: (v: string) => void;
	models: ModelList;
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
		<span className="affix">
			{/* Uncontrolled on purpose: no value prop, so the key never becomes a DOM attribute. */}
			<input
				ref={inputRef}
				type="password"
				autoComplete="current-password"
				spellCheck={false}
				placeholder="sk-..."
				onChange={onInput && ((e) => onInput(e.currentTarget.value))}
				aria-invalid={invalid || undefined}
				aria-describedby={invalid ? describedBy : undefined}
				data-testid={testId}
			/>
			<button type="button" className="btn-text" aria-pressed={shown} onClick={toggle}>
				{shown ? "隐藏密钥" : "显示密钥"}
			</button>
		</span>
	);
}

export function TargetPanel(props: { site: string; setSite: (v: string) => void; setKey: (v: string) => void; hidden: boolean }) {
	const keyInput = useRef<HTMLInputElement>(null);
	const privacy = usePrivacy();

	return (
		<section className="panel target-panel" aria-labelledby="target-h" hidden={props.hidden}>
			<h2 id="target-h">站点与密钥</h2>
			<div className="grid">
				<label className="field col-12 col-md-6">
					<span className="field-label">站点地址</span>
					<input
						type="text"
						inputMode="url"
						autoComplete="username"
						placeholder="https://example.com"
						value={props.site}
						onChange={(e) => props.setSite(e.currentTarget.value)}
						className={privateInputClass(privacy)}
						data-testid="site-input"
					/>
				</label>
				<label className="field col-12 col-md-6">
					<span className="field-label">密钥</span>
					<SecretInput inputRef={keyInput} testId="key-input" onInput={(v) => props.setKey(normalizeKey(v))} />
				</label>
			</div>
		</section>
	);
}

export function TestForm(props: Props) {
	return (
		<section className="panel col-12" aria-labelledby="form-h">
			<h2 id="form-h">实时测试</h2>
			<form
				className="run-form"
				onSubmit={(e) => {
					e.preventDefault();
					props.onStart();
				}}
			>
				<ModelField value={props.model} onInput={props.setModel} list={props.models} testId="model-input" />
				<div className="run-form-actions">
					{/* Distinct keys force a new node: reusing one would flip its type to submit inside the cancel click and resubmit the form. */}
					{props.running ? (
						<button key="cancel" type="button" className="btn btn-secondary" onClick={props.onCancel} data-testid="cancel-button">
							取消
						</button>
					) : (
						<button key="start" type="submit" className="btn btn-primary" disabled={props.selectedCount === 0} data-testid="start-button">
							开始测试
						</button>
					)}
				</div>
				{props.error && (
					<p className="field-error" role="alert">
						{props.error}
					</p>
				)}
				<p className="muted small" data-testid="cost-line">
					{costLine(props.selectedCount)}
				</p>
			</form>
		</section>
	);
}

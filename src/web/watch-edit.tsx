import { useState } from "react";
import { WATCH_MAX_EMAIL, type WatchChange, type WatchView } from "../shared/watch.ts";
import { useWatchStrategy, WatchStrategyFields } from "./watch-strategy.tsx";
import { parseWatchEdit } from "./watch.ts";

type Props = { testPrefix: string; view: WatchView; onSave: (change: WatchChange) => Promise<string | null>; onClose: () => void };

export function WatchEditForm({ testPrefix: t, view, onSave, onClose }: Props) {
	const strategy = useWatchStrategy({ intervalMin: view.intervalMin, questions: view.questions, measure: view.perf !== null });
	const [alertEmail, setAlertEmail] = useState("");
	const [clearEmail, setClearEmail] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		const draft = parseWatchEdit(
			{
				questions: strategy.questions.picked,
				intervalMin: strategy.intervalMin,
				measure: strategy.measure,
				alertEmail,
				clearAlertEmail: clearEmail,
			},
			{ intervalMin: view.intervalMin, measure: view.perf !== null },
		);
		if (!draft.ok) return setError(draft.error.message);
		setBusy(true);
		setError(null);
		const failure = await onSave(draft.change);
		setBusy(false);
		if (failure) setError(failure);
	};

	return (
		<form
			className="watch-edit grid"
			data-testid={`${t}-edit-form`}
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<WatchStrategyFields testPrefix={t} strategy={strategy} />
			<label className="field col-12">
				<span className="field-label">告警邮箱（可选）</span>
				<input
					type="email"
					maxLength={WATCH_MAX_EMAIL}
					placeholder={view.hasAlertEmail ? "已加密保存，输入新邮箱可替换" : "name@example.com"}
					autoComplete="off"
					disabled={clearEmail}
					value={alertEmail}
					onChange={(e) => setAlertEmail(e.currentTarget.value)}
					data-testid={`${t}-edit-email`}
				/>
				<p className="muted small">邮箱在服务端加密保存，不回显原文；支持直接回复邮件发送 pause、resume 或 recheck。</p>
			</label>
			{view.hasAlertEmail && (
				<div className="field col-12">
					<label className="consent-row">
						<input
							type="checkbox"
							checked={clearEmail}
							onChange={(e) => setClearEmail(e.currentTarget.checked)}
							data-testid={`${t}-edit-email-clear`}
						/>
						<span>清除已保存的告警邮箱</span>
					</label>
				</div>
			)}
			{error && (
				<p className="field-error" role="alert" data-testid={`${t}-edit-error`}>
					{error}
				</p>
			)}
			<div className="actions">
				<button type="button" className="btn btn-secondary" onClick={onClose}>
					取消
				</button>
				<button type="submit" className="btn btn-primary" disabled={busy || strategy.questions.questions === null} data-testid={`${t}-edit-save`}>
					{busy ? "正在保存…" : "保存"}
				</button>
			</div>
		</form>
	);
}

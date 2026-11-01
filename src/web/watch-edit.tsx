import { useState } from "preact/hooks";
import type { WatchChange, WatchView } from "../shared/watch.ts";
import { useWatchStrategy, WatchStrategyFields } from "./watch-strategy.tsx";
import { parseWatchEdit } from "./watch.ts";

type Props = { testPrefix: string; view: WatchView; onSave: (change: WatchChange) => Promise<string | null>; onClose: () => void };

export function WatchEditForm({ testPrefix: t, view, onSave, onClose }: Props) {
	const strategy = useWatchStrategy({ intervalMin: view.intervalMin, questions: view.questions });
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		const draft = parseWatchEdit({ questions: strategy.questions.picked, intervalMin: strategy.intervalMin }, view.intervalMin);
		if (!draft.ok) return setError(draft.error.message);
		setBusy(true);
		setError(null);
		const failure = await onSave(draft.change);
		setBusy(false);
		if (failure) setError(failure);
	};

	return (
		<form
			class="watch-edit grid"
			data-testid={`${t}-edit-form`}
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<WatchStrategyFields testPrefix={t} strategy={strategy} />
			{error && (
				<p class="field-error" role="alert" data-testid={`${t}-edit-error`}>
					{error}
				</p>
			)}
			<div class="actions">
				<button type="button" class="btn btn-secondary" onClick={onClose}>
					取消
				</button>
				<button type="submit" class="btn btn-primary" disabled={busy || strategy.questions.questions === null} data-testid={`${t}-edit-save`}>
					{busy ? "正在保存…" : "保存"}
				</button>
			</div>
		</form>
	);
}

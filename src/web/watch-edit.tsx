import { useState } from "preact/hooks";
import { isWatchInterval, WATCH_INTERVALS, type WatchChange, type WatchView } from "../shared/watch.ts";
import { ChoiceField, QuestionPicks, useWatchQuestions } from "./watch-add.tsx";
import { parseWatchEdit } from "./watch.ts";

// A watch on a retired interval lists it too, so saving a question edit does not move it to another interval.
const intervalOptions = (current: number): number[] => (isWatchInterval(current) ? [...WATCH_INTERVALS] : [...WATCH_INTERVALS, current].sort((a, b) => a - b));

type Props = { testPrefix: string; view: WatchView; onSave: (change: WatchChange) => Promise<string | null>; onClose: () => void };

export function WatchEditForm({ testPrefix: t, view, onSave, onClose }: Props) {
	const questions = useWatchQuestions(view.questions);
	const [intervalMin, setIntervalMin] = useState(view.intervalMin);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		const draft = parseWatchEdit({ questions: questions.picked, intervalMin }, view.intervalMin);
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
			<QuestionPicks {...questions} testPrefix={t} />
			<ChoiceField label="间隔" testId={`${t}-interval`} value={intervalMin} options={intervalOptions(view.intervalMin)} text={(i) => `每 ${i} 分钟`} onChange={setIntervalMin} class="col-12" />
			{error && (
				<p class="field-error" role="alert" data-testid={`${t}-edit-error`}>
					{error}
				</p>
			)}
			<div class="actions">
				<button type="button" class="btn btn-secondary" onClick={onClose}>
					取消
				</button>
				<button type="submit" class="btn btn-primary" disabled={busy || questions.questions === null} data-testid={`${t}-edit-save`}>
					{busy ? "正在保存…" : "保存"}
				</button>
			</div>
		</form>
	);
}

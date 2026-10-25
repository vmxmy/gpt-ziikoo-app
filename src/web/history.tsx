import { useState } from "preact/hooks";
import type { RunView } from "../shared/types.ts";
import { deleteHistory, fetchHistory, fetchHistoryRaw, type Target } from "./api.ts";
import { ms, OVERALL_LABEL, VERDICT_LABEL } from "./results.ts";

const time = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

function download(name: string, data: unknown) {
	const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	URL.revokeObjectURL(url);
}

function HistoryRun({ run: r, busy, onRaw }: { run: RunView; busy: boolean; onRaw: (runId: string) => void }) {
	return (
		<li data-testid="history-run">
			<p class="history-head">
				<strong>{OVERALL_LABEL[r.overall]}</strong>
				<span class="muted num">{time(r.startedAt)}</span>
				<span class="mono muted">
					{r.model} · {r.protocol}
				</span>
			</p>
			<ul class="history-questions">
				{r.questions.map((q) => (
					<li key={q.id}>
						<span class="mono">
							{q.id} v{q.version}
						</span>
						：{q.verdict ? `${VERDICT_LABEL[q.verdict.status]} ${q.verdict.correct}/${q.verdict.total}` : "仅度量"}
						，有效 {q.metrics.validCalls}/{q.metrics.calls}，总耗时中位数 {ms(q.metrics.totalMs?.p50)}，首字耗时中位数{" "}
						{ms(q.metrics.ttftMs?.p50)}
					</li>
				))}
			</ul>
			<button type="button" class="btn-text" disabled={busy} onClick={() => onRaw(r.runId)} data-testid="history-raw-button">
				下载原始数据
			</button>
		</li>
	);
}

export function History({ target }: { target: Target }) {
	const [runs, setRuns] = useState<RunView[] | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const ready = target.site !== "" && target.key !== "";

	const act = async (task: () => Promise<void>) => {
		setBusy(true);
		setMessage("");
		await task().catch((err: unknown) => setMessage(err instanceof Error ? err.message : "请求失败"));
		setBusy(false);
	};

	const load = () => act(async () => setRuns((await fetchHistory(target)).runs));
	const raw = (runId: string) => act(async () => download(`gpt-test-${runId}.json`, await fetchHistoryRaw(target, runId)));
	const remove = () => {
		if (!confirm("确定删除此站点与密钥下的全部历史？删除后无法恢复。")) return;
		act(async () => {
			await deleteHistory(target);
			setRuns([]);
			setMessage("已删除");
		});
	};

	return (
		<section class="block col-12" id="history" aria-labelledby="history-h" data-testid="history-section">
			<h2 id="history-h">历史</h2>
			<p class="muted">用上面填写的站点与密钥取回最近 10 轮。</p>
			<div class="actions">
				<button type="button" class="btn btn-secondary" disabled={!ready || busy} onClick={load}>
					查看历史
				</button>
				<button type="button" class="btn btn-danger" disabled={!ready || busy} onClick={remove} data-testid="history-delete-button">
					删除全部历史
				</button>
			</div>
			{message && <p role="status">{message}</p>}
			{runs?.length === 0 && <p class="muted" data-testid="history-empty">暂无历史</p>}
			{runs && runs.length > 0 && (
				<ul class="history">
					{runs.map((r) => (
						<HistoryRun key={r.runId} run={r} busy={busy} onRaw={raw} />
					))}
				</ul>
			)}
		</section>
	);
}

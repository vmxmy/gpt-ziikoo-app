import { useEffect, useState } from "preact/hooks";
import { MONITOR, type MonitorBucket, type MonitorResponse, type MonitorState } from "../shared/monitor.ts";
import { fetchMonitor } from "./api.ts";
import { CHART, chartModel } from "./chart.ts";
import { ms, pct } from "./results.ts";

const STATE_LABEL: Record<MonitorState, string> = {
	operational: "运行正常",
	degraded: "降级",
	down: "故障",
	no_data: "暂无数据",
};

const REFRESH_MS = 60_000;

const clock = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });

const emptyBuckets = (): MonitorBucket[] =>
	Array.from({ length: MONITOR.buckets }, () => ({
		start: 0,
		state: "no_data",
		total: 0,
		failed: 0,
		wrong: 0,
		totalMs: null,
		ttftMs: null,
	}));

function Chart({ buckets }: { buckets: MonitorBucket[] }) {
	const m = chartModel(buckets);
	const timed = buckets.filter((b) => b.start > 0);
	return (
		<figure class="chart">
			<svg
				viewBox={`0 0 ${CHART.width} ${CHART.height}`}
				role="img"
				aria-label={`近 24 小时每半小时总耗时与首字时延的中位数，纵轴最大 ${m.maxMs} 毫秒`}
				data-testid="monitor-chart"
			>
				{m.ticks.map((t) => (
					<g key={t.label}>
						<line class="grid" x1={CHART.left} x2={CHART.width - CHART.right} y1={t.y} y2={t.y} />
						<text class="axis" x={CHART.left - 6} y={t.y + 4} text-anchor="end">
							{t.label}
						</text>
					</g>
				))}
				{timed.length > 0 && (
					<>
						<text class="axis" x={CHART.left} y={CHART.height - 6}>
							{clock(timed[0]!.start)}
						</text>
						<text class="axis" x={CHART.width - CHART.right} y={CHART.height - 6} text-anchor="end">
							{clock(timed[timed.length - 1]!.start)}
						</text>
					</>
				)}
				<path class="line-total" d={m.totalPath} />
				<path class="line-ttft" d={m.ttftPath} />
			</svg>
			<figcaption>
				<span class="key key-total">总耗时 p50</span> <span class="key key-ttft">TTFT p50</span>（毫秒，空白处无数据）
			</figcaption>
			<details>
				<summary>数据表</summary>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>开始</th>
								<th>总耗时 p50</th>
								<th>TTFT p50</th>
							</tr>
						</thead>
						<tbody>
							{timed.map((b) => (
								<tr key={b.start}>
									<td>{clock(b.start)}</td>
									<td>{ms(b.totalMs?.p50)}</td>
									<td>{ms(b.ttftMs?.p50)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
		</figure>
	);
}

export function Monitor() {
	const [data, setData] = useState<MonitorResponse | null>(null);

	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const refresh = () => fetchMonitor().then(setData);
		const schedule = () => {
			clearInterval(timer);
			timer = undefined;
			if (document.hidden) return;
			refresh();
			timer = setInterval(refresh, REFRESH_MS);
		};
		schedule();
		document.addEventListener("visibilitychange", schedule);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", schedule);
		};
	}, []);

	const state = data?.state ?? "no_data";
	const buckets = data?.buckets.length === MONITOR.buckets ? data.buckets : emptyBuckets();
	return (
		<section aria-labelledby="monitor-h" data-testid="monitor-section">
			<h2 id="monitor-h">监测</h2>
			<p>
				<span class="badge" data-testid="monitor-badge" data-state={state}>
					{STATE_LABEL[state]}
				</span>
				{data && <span class="muted"> 目标 {data.target}，每 {data.intervalSec} 秒一次</span>}
			</p>
			<div class="bar" data-testid="monitor-bar" role="list" aria-label="近 24 小时状态，每格半小时">
				{buckets.map((b, i) => (
					<span
						role="listitem"
						class="segment"
						data-testid="monitor-segment"
						data-state={b.state}
						key={i}
						title={
							b.start > 0
								? `${clock(b.start)} · ${STATE_LABEL[b.state]} · 调用 ${b.total} · 失败 ${b.failed} · 答错 ${b.wrong}`
								: STATE_LABEL[b.state]
						}
					/>
				))}
			</div>
			<p>
				24 小时可用率 <strong data-testid="monitor-uptime">{pct(data?.uptimePct ?? null)}</strong>，答对率{" "}
				<strong data-testid="monitor-correct">{pct(data?.correctPct ?? null)}</strong>
			</p>
			<Chart buckets={buckets} />
		</section>
	);
}

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { MONITOR, type MonitorBucket, type MonitorState } from "../shared/monitor.ts";
import type { Protocol } from "../shared/types.ts";
import { CHART, chartModel, xOf, xTickIndexes, type Point } from "./chart.ts";
import {
	badgeLabel,
	clock,
	emptyBuckets,
	latencyP50,
	metaLine,
	segmentLabel,
	type MonitorView,
	WAITING_NOTICE,
} from "./monitor-view.ts";
import { ms, pct } from "./results.ts";

const LEGEND: Record<MonitorState, string> = { operational: "正常", degraded: "降级", down: "故障", no_data: "无数据" };
const BAR_HINT = "悬停或聚焦任一格查看该半小时的详情";

// `testPrefix` keeps the official card on its original test ids and gives each custom card its own.
export type CardProps = {
	testPrefix: string;
	rootTestId: string;
	host: string;
	alias?: string;
	source: string;
	protocol?: Protocol;
	view: MonitorView;
	now: number;
	actions?: ComponentChildren;
	children?: ComponentChildren;
};

export function MonitorCard(props: CardProps) {
	const { testPrefix: t, view } = props;
	const { data } = view;
	const buckets = data.buckets.length === MONITOR.buckets ? data.buckets : emptyBuckets();
	const headingId = `${t}-h`;
	return (
		<section class="card monitor-card" aria-labelledby={headingId} data-testid={props.rootTestId}>
			<header class="card-head">
				<h3 id={headingId} class="card-title">
					{props.alias && <span class="card-alias">{props.alias}</span>}
					<span class={props.alias ? "mono muted" : "mono"}>{props.host}</span>
					<span class="tag">{props.source}</span>
				</h3>
				{props.actions && <div class="card-actions">{props.actions}</div>}
			</header>
			<div class="card-status">
				<p class="status-badge" data-testid={`${t}-badge`} data-state={data.state}>
					{badgeLabel(view)}
				</p>
				<p class="meta">{metaLine(data, props.now, props.protocol)}</p>
			</div>
			{props.children}
			<Metrics t={t} uptime={data.uptimePct} correct={data.correctPct} p50={latencyP50(buckets)} />
			<StatusBar t={t} buckets={buckets} />
			{view.kind === "live" ? (
				<Chart t={t} buckets={buckets} />
			) : (
				<p class="chart-empty" data-testid={`${t}-chart`} data-kind={view.kind}>
					{WAITING_NOTICE}
				</p>
			)}
		</section>
	);
}

function Metrics(props: { t: string; uptime: number | null; correct: number | null; p50: number | null }) {
	return (
		<dl class="metrics">
			<div>
				<dt>24 小时可用率</dt>
				<dd class="num" data-testid={`${props.t}-uptime`}>
					{pct(props.uptime)}
				</dd>
			</div>
			<div>
				<dt>24 小时答对率</dt>
				<dd class="num" data-testid={`${props.t}-correct`}>
					{pct(props.correct)}
				</dd>
			</div>
			<div>
				<dt title="各半小时格总时延 p50 的中位数">总时延 p50</dt>
				<dd class="num">{ms(props.p50)}</dd>
			</div>
		</dl>
	);
}

function StatusBar({ t, buckets }: { t: string; buckets: MonitorBucket[] }) {
	const [active, setActive] = useState<number | null>(null);
	return (
		<div class="bar-block">
			<div class="bar" data-testid={`${t}-bar`} role="list" aria-label="近 24 小时状态，每格半小时" onMouseLeave={() => setActive(null)}>
				{buckets.map((b, i) => (
					<span
						role="listitem"
						tabindex={0}
						class="segment"
						data-testid={`${t}-segment`}
						data-state={b.state}
						aria-label={segmentLabel(b)}
						onMouseEnter={() => setActive(i)}
						onFocus={() => setActive(i)}
						onBlur={() => setActive(null)}
						key={i}
					/>
				))}
			</div>
			<div class="bar-scale" aria-hidden="true">
				<span>24 小时前</span>
				<span>12 小时前</span>
				<span>现在</span>
			</div>
			<div class="bar-foot">
				<p class="readout" aria-live="polite">
					{active === null ? BAR_HINT : segmentLabel(buckets[active]!)}
				</p>
				<ul class="legend" aria-label="图例">
					{Object.entries(LEGEND).map(([state, label]) => (
						<li data-state={state} key={state}>
							{label}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

function useWidth(fallback: number) {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(fallback);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return { ref, width };
}

const Marker = ({ p, cls }: { p: Point | null; cls: string }) => (p ? <circle class={cls} cx={p.x} cy={p.y} r={3.5} /> : null);

function ChartTable({ buckets }: { buckets: MonitorBucket[] }) {
	return (
		<details class="chart-table">
			<summary>数据表</summary>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>开始</th>
							<th class="num">总时延 p50</th>
							<th class="num">TTFT p50</th>
						</tr>
					</thead>
					<tbody>
						{buckets
							.filter((b) => b.start > 0)
							.map((b) => (
								<tr key={b.start}>
									<td class="mono">{clock(b.start)}</td>
									<td class="num">{ms(b.totalMs?.p50)}</td>
									<td class="num">{ms(b.ttftMs?.p50)}</td>
								</tr>
							))}
					</tbody>
				</table>
			</div>
		</details>
	);
}

function TimeAxis({ buckets, width }: { buckets: MonitorBucket[]; width: number }) {
	const ticks = xTickIndexes(buckets.length);
	return (
		<>
			{ticks.map((i, n) => (
				<text
					class="axis"
					key={i}
					x={xOf(i, buckets.length, width)}
					y={CHART.height - 8}
					text-anchor={n === 0 ? "start" : n === ticks.length - 1 ? "end" : "middle"}
				>
					{buckets[i]!.start > 0 ? clock(buckets[i]!.start) : ""}
				</text>
			))}
		</>
	);
}

function Chart({ t, buckets }: { t: string; buckets: MonitorBucket[] }) {
	const { ref, width } = useWidth(CHART.width);
	const m = chartModel(buckets, width);
	return (
		<figure class="chart">
			<div ref={ref} class="chart-canvas">
				<svg
					viewBox={`0 0 ${width} ${CHART.height}`}
					role="img"
					aria-label={`近 24 小时每半小时总时延与首字时延的中位数，纵轴最大 ${m.maxMs} 毫秒`}
					data-testid={`${t}-chart`}
				>
					{m.yTicks.map((tick) => (
						<g key={tick.label}>
							<line class="gridline" x1={CHART.left} x2={width - CHART.right} y1={tick.pos} y2={tick.pos} />
							<text class="axis" x={CHART.left - 8} y={tick.pos + 4} text-anchor="end">
								{tick.label}
							</text>
						</g>
					))}
					<TimeAxis buckets={buckets} width={width} />
					<path class="line-total" d={m.totalPath} />
					<path class="line-ttft" d={m.ttftPath} />
					<Marker p={m.totalLast} cls="dot-total" />
					<Marker p={m.ttftLast} cls="dot-ttft" />
				</svg>
			</div>
			<figcaption>
				<span class="key key-total">总时延 p50</span>
				<span class="key key-ttft">TTFT p50</span>
				<span class="muted">断开处无数据</span>
			</figcaption>
			<ChartTable buckets={buckets} />
		</figure>
	);
}

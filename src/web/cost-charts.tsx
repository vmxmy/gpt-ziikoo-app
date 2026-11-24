import { barSegments, CURVE, curveMarker, curvePath, curveX, curveY, pct, perThousand, SERIES, type Calc, type Cost, type Scenario, type Series } from "./cost.ts";
import { useWidth } from "./monitor-card.tsx";

const SERIES_LABEL: Record<Series, string> = { hit: "缓存命中", miss: "未命中输入", out: "输出" };
const HIT_TICKS = [0, 0.25, 0.5, 0.75, 1];
const MULTIPLIER_TICKS = [0.05, 0.1, 0.2, 0.5, 1, 2];
const MARKER_RADIUS = 7;
const CURVE_FALLBACK_WIDTH = 480;

function Bars({ result }: { result: Calc }) {
	const max = Math.max(result.ref.total, result.exp.total);
	const rows: [string, Cost, string][] = [
		["对照", result.ref, "cost-party-ref"],
		["站点", result.exp, "cost-party-site"],
	];
	const label = `每千次调用的账单，对照 ${perThousand(result.ref.total)}，站点 ${perThousand(result.exp.total)}`;
	return (
		<figure className="cost-figure">
			<div className="cost-bars" role="img" aria-label={label} data-testid="cost-bars">
				{rows.map(([name, cost, party]) => (
					<div className={`cost-bar-row ${party}`} key={name}>
						<span className="small">{name}</span>
						<svg viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">
							{barSegments(cost, max).map((seg) => (
								<rect key={seg.series} className={`cost-seg cost-seg-${seg.series}`} x={seg.start * 100} y="0" width={seg.share * 100} height="1" />
							))}
						</svg>
					</div>
				))}
			</div>
			<figcaption className="muted small">两根条同刻度，较长的一根占满宽度。</figcaption>
			<div className="table-wrap">
				<table data-testid="cost-legend">
					<thead>
						<tr>
							<th scope="col">每千次调用</th>
							{rows.map(([name, , party]) => (
								<th scope="col" className={`num ${party}`} key={name}>
									{name}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{SERIES.map((s) => (
							<tr key={s}>
								<th scope="row">
									<span className={`cost-swatch cost-swatch-${s}`} aria-hidden="true" /> {SERIES_LABEL[s]}
								</th>
								{rows.map(([name, cost, party]) => (
									<td className={`num ${party}`} key={name}>
										{perThousand(cost[s])} · {pct(cost[s] / cost.total)}
									</td>
								))}
							</tr>
						))}
						<tr>
							<th scope="row">合计</th>
							{rows.map(([name, cost, party]) => (
								<td className={`num ${party}`} key={name}>
									{perThousand(cost.total)}
								</td>
							))}
						</tr>
					</tbody>
				</table>
			</div>
		</figure>
	);
}

function Curve({ scenario, result }: { scenario: Scenario; result: Calc }) {
	const { ref, width } = useWidth(CURVE_FALLBACK_WIDTH);
	const { x, y } = curveMarker(scenario, width);
	const side = result.ratio > 1 ? "站点更贵" : "站点不比对照贵";
	const label = `临界缓存命中率曲线。站点的倍率 ×${scenario.exp.multiplier.toFixed(2)}，缓存命中率 ${pct(scenario.exp.hitRate)}，菱形点是当前设置，${side}`;
	const plotRight = width - CURVE.right;
	const axisY = CURVE.height - CURVE.bottom;
	return (
		<figure className="cost-figure">
			<div ref={ref} className="cost-curve-canvas">
				<svg viewBox={`0 0 ${width} ${CURVE.height}`} role="img" aria-label={label} data-testid="cost-curve">
					{HIT_TICKS.map((t) => (
						<g key={t}>
							<line className="cost-grid" x1={CURVE.left} x2={plotRight} y1={curveY(t)} y2={curveY(t)} />
							<text className="cost-axis-text" textAnchor="end" x={CURVE.left - 6} y={curveY(t) + 4}>
								{pct(t)}
							</text>
						</g>
					))}
					{MULTIPLIER_TICKS.map((m) => (
						<text key={m} className="cost-axis-text" textAnchor="middle" x={curveX(m, width)} y={axisY + 18}>
							{m}
						</text>
					))}
					<path className="cost-curve" d={curvePath(scenario, width)} />
					<path className="cost-marker" d={`M${x},${y - MARKER_RADIUS}L${x + MARKER_RADIUS},${y}L${x},${y + MARKER_RADIUS}L${x - MARKER_RADIUS},${y}Z`} />
				</svg>
			</div>
			<figcaption className="muted small">横轴是站点的倍率（对数刻度），纵轴是临界缓存命中率，只画当前模型一条线。菱形点是当前设置，点在线上方表示站点更便宜，下方表示更贵。</figcaption>
		</figure>
	);
}

export function CostCharts({ scenario, result }: { scenario: Scenario; result: Calc }) {
	return (
		<div className="cost-figures">
			<Bars result={result} />
			<Curve scenario={scenario} result={result} />
		</div>
	);
}

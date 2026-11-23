import { useState } from "preact/hooks";
import { CostCharts } from "./cost-charts.tsx";
import "./cost.css";
import { calc, DEFAULT_SCENARIO, MODEL_IDS, PRICES, pct, perThousand, type BreakEven, type Calc, type Channel, type ModelId, type Scenario } from "./cost.ts";

type Slider = {
	id: string;
	label: string;
	hint?: string;
	min: number;
	max: number;
	step: number;
	read: (s: Scenario) => number;
	write: (s: Scenario, v: number) => Scenario;
	text: (v: number) => string;
};
type ChannelKey = "ref" | "exp";

const count = (v: number) => v.toLocaleString("zh-CN");
const times = (v: number) => `×${v.toFixed(2)}`;
const percent = (v: number) => `${v}%`;
const points = (rate: number) => Math.round(rate * 100);

const withChannel = (s: Scenario, key: ChannelKey, patch: Partial<Channel>): Scenario =>
	key === "ref" ? { ...s, ref: { ...s.ref, ...patch } } : { ...s, exp: { ...s.exp, ...patch } };

const multiplier = (key: ChannelKey): Slider => ({
	id: `${key}-multiplier`,
	label: "倍率",
	min: 0.05,
	max: 2,
	step: 0.05,
	read: (s) => s[key].multiplier,
	write: (s, v) => withChannel(s, key, { multiplier: v }),
	text: times,
});

const hitRate = (key: ChannelKey): Slider => ({
	id: `${key}-hit`,
	label: "缓存命中率",
	min: 0,
	max: 100,
	step: 1,
	read: (s) => points(s[key].hitRate),
	write: (s, v) => withChannel(s, key, { hitRate: v / 100 }),
	text: percent,
});

const INPUT: Slider = { id: "input", label: "输入 token 数", min: 10_000, max: 200_000, step: 5000, read: (s) => s.inputTokens, write: (s, v) => ({ ...s, inputTokens: v }), text: count };
const OUTPUT: Slider = { id: "output", label: "输出 token 数", min: 0, max: 8000, step: 100, read: (s) => s.outputTokens, write: (s, v) => ({ ...s, outputTokens: v }), text: count };
const REF_MULTIPLIER = multiplier("ref");
const EXP_MULTIPLIER: Slider = { ...multiplier("exp"), hint: "站点标出的" };
const REF_HIT = hitRate("ref");
const EXP_HIT: Slider = { ...hitRate("exp"), hint: "你实际得到的" };
const OFFICIAL_MULTIPLIER = 1;
const REF_KINDS = [
	{ id: "official", label: "官方价", official: true },
	{ id: "custom", label: "自定义倍率", official: false },
];

const safety = (b: BreakEven): string => {
	if (b.kind === "never") return "就算缓存命中率降到 0%，也不会比对照贵。";
	return b.kind === "below" ? `缓存命中率再降到 ${pct(b.hitRate)} 以下就会反超。` : "";
};

function conclusion(s: Scenario, r: Calc): string {
	const head = `用 ${PRICES.models[s.model].name}，站点的倍率是对照的 ${pct(r.priceRatio)}`;
	const gap = points(s.ref.hitRate) - points(s.exp.hitRate);
	const cause = gap > 0 ? `，缓存命中率低 ${gap} 个点，账单因此 ${times(r.hitFactor)}` : "";
	if (r.ratio > 1) return `${head}${cause}，最终比对照贵 ${pct(r.ratio - 1)}。`;
	const tail = r.discountEaten === null ? "。" : `，吃掉了 ${pct(r.discountEaten)} 的折扣。`;
	return `${head}${cause}${tail}${safety(r.breakEven)}`;
}

function breakEvenText(b: BreakEven): string {
	switch (b.kind) {
		case "never":
			return "不会";
		case "always":
			return "100% 也更贵";
		case "already":
			return "已经更贵";
		case "below":
			return pct(b.hitRate);
	}
}

function modelPrices(model: ModelId): string {
	const p = PRICES.models[model];
	return `官方价每百万 token：缓存命中 $${p.hit}，未命中输入 $${p.miss}，输出 $${p.out}。未命中输入的单价是缓存命中的 ${Math.round(p.miss / p.hit)} 倍。`;
}

function footnote(model: ModelId): string {
	const p = PRICES.models[model];
	const peak = p.peak ? `${p.name} 取高峰价，非高峰价减半，比例不变。` : "";
	return `价格快照 ${PRICES.asOf}，以官网为准。${peak}本页只在浏览器里计算，不接触站点与密钥。`;
}

type RangeProps = { spec: Slider; scenario: Scenario; onInput: (s: Scenario) => void; onCommit: (s: Scenario) => void };

function Range({ spec, scenario, onInput, onCommit }: RangeProps) {
	const id = `cost-${spec.id}`;
	const value = spec.read(scenario);
	return (
		<div class="cost-field">
			<label for={id}>{spec.label}</label>
			<output class="num" data-testid={`${id}-value`}>
				{spec.text(value)}
			</output>
			{spec.hint && <span class="cost-field-hint">{spec.hint}</span>}
			<input
				id={id}
				type="range"
				min={spec.min}
				max={spec.max}
				step={spec.step}
				value={value}
				onInput={(e) => onInput(spec.write(scenario, e.currentTarget.valueAsNumber))}
				onChange={(e) => onCommit(spec.write(scenario, e.currentTarget.valueAsNumber))}
				data-testid={id}
			/>
		</div>
	);
}

function Result({ scenario, result }: { scenario: Scenario; result: Calc }) {
	const facts: [string, string, string][] = [
		["倍率差让账单", times(result.priceRatio), "cost-price-ratio"],
		["缓存命中率差让账单", times(result.hitFactor), "cost-hit-factor"],
		["临界缓存命中率", breakEvenText(result.breakEven), "cost-breakeven"],
	];
	return (
		<div class="cost-result" data-testid="cost-result">
			<p class="cost-ratio" data-cost={result.ratio <= 1 ? "cheaper" : "dearer"} data-testid="cost-ratio">
				{pct(result.ratio)}
			</p>
			<p class="muted small">
				站点账单占对照账单的比例。每千次调用，对照 {perThousand(result.ref.total)}，站点 {perThousand(result.exp.total)}。
			</p>
			<p data-testid="cost-conclusion">{conclusion(scenario, result)}</p>
			<dl class="cost-facts">
				{facts.map(([term, text, testId]) => (
					<div key={testId}>
						<dt>{term}</dt>
						<dd data-testid={testId}>{text}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

export function CostView() {
	const [scenario, setScenario] = useState(DEFAULT_SCENARIO);
	const [official, setOfficial] = useState(true);
	const [announced, setAnnounced] = useState(() => conclusion(DEFAULT_SCENARIO, calc(DEFAULT_SCENARIO)));
	const result = calc(scenario);
	const commit = (next: Scenario) => {
		setScenario(next);
		setAnnounced(conclusion(next, calc(next)));
	};
	const chooseRef = (isOfficial: boolean) => {
		setOfficial(isOfficial);
		commit(isOfficial ? withChannel(scenario, "ref", { multiplier: OFFICIAL_MULTIPLIER }) : scenario);
	};
	const range = (spec: Slider) => <Range spec={spec} scenario={scenario} onInput={setScenario} onCommit={commit} />;

	return (
		<section class="panel" aria-labelledby="cost-h">
			<h2 id="cost-h">折扣核算</h2>
			<p class="cost-lead">倍率低，账单不一定低。倍率决定单价，缓存命中率决定多少输入按缓存价计费。</p>
			<div class="cost-premise">
				<div class="cost-layer" role="group" aria-labelledby="cost-model-h">
					<h3 id="cost-model-h" class="cost-layer-title">
						模型<span class="cost-role">按它的官方价计算</span>
					</h3>
					<div class="cost-choice" role="radiogroup" aria-label="模型">
						{MODEL_IDS.map((id) => (
							<label class="cost-radio" key={id}>
								<input type="radio" name="cost-model" checked={scenario.model === id} onChange={() => commit({ ...scenario, model: id })} data-testid={`cost-model-${id}`} />
								{PRICES.models[id].name}
							</label>
						))}
					</div>
					<p class="muted small" data-testid="cost-model-prices">
						{modelPrices(scenario.model)}
					</p>
				</div>
				<div class="cost-layer" role="group" aria-labelledby="cost-usage-h">
					<h3 id="cost-usage-h" class="cost-layer-title">
						用量假设<span class="cost-role">两边共用，按每次调用计</span>
					</h3>
					<div class="cost-usage">
						{range(INPUT)}
						{range(OUTPUT)}
					</div>
				</div>
			</div>
			<div class="cost-compare">
				<div class="cost-channel" role="group" aria-labelledby="cost-ref-h">
					<div class="cost-channel-head">
						<h3 id="cost-ref-h">
							对照<span class="cost-role">拿来比的一方</span>
						</h3>
						<div class="cost-choice" role="radiogroup" aria-label="对照的倍率">
							{REF_KINDS.map((kind) => (
								<label class="cost-radio" key={kind.id}>
									<input type="radio" name="cost-ref-kind" checked={official === kind.official} onChange={() => chooseRef(kind.official)} data-testid={`cost-ref-${kind.id}`} />
									{kind.label}
								</label>
							))}
						</div>
					</div>
					{official ? (
						<div class="cost-field">
							<span>倍率</span>
							<output class="num">{times(OFFICIAL_MULTIPLIER)}</output>
							<span class="cost-field-hint">官方价固定为 1</span>
						</div>
					) : (
						range(REF_MULTIPLIER)
					)}
					{range(REF_HIT)}
				</div>
				<div class="cost-channel" role="group" aria-labelledby="cost-exp-h">
					<div class="cost-channel-head">
						<h3 id="cost-exp-h">
							站点<span class="cost-role">要核算的一方</span>
						</h3>
					</div>
					{range(EXP_MULTIPLIER)}
					{range(EXP_HIT)}
				</div>
			</div>
			<p class="sr-only" role="status" data-testid="cost-status">
				{announced}
			</p>
			<Result scenario={scenario} result={result} />
			<CostCharts scenario={scenario} result={result} />
			<p class="cost-prices muted small" data-testid="cost-prices">
				{footnote(scenario.model)}
			</p>
		</section>
	);
}

export type Cell = readonly [shape: 0 | 1, hidden: number];
export type Pair = readonly [Cell, Cell];
export type BagSolution = { total: number; splits: readonly (readonly [number, number])[] };

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

// A failure pattern is a pair of allowed-hidden-value sets (one per shape) under which no pair can form.
// The adversary defeats (c, s) iff some pattern can hold c shape-0 and s shape-1 items.
function failureCaps(shape0: readonly number[], shape1: readonly number[], pairs: readonly Pair[]): [number, number][] {
	const rows = [shape0, shape1] as const;
	const full = 1 << shape0.length;
	const caps: [number, number][] = [];
	for (let m0 = 0; m0 < full; m0++) {
		for (let m1 = 0; m1 < full; m1++) {
			const masks = [m0, m1];
			const allowed = ([shape, hidden]: Cell) => ((masks[shape] >> hidden) & 1) === 1;
			if (pairs.some(([a, b]) => allowed(a) && allowed(b))) continue;
			const cap = (shape: 0 | 1) => sum(rows[shape].filter((_, i) => ((masks[shape] >> i) & 1) === 1));
			caps.push([cap(0), cap(1)]);
		}
	}
	return caps;
}

export function solveBag(shape0: readonly number[], shape1: readonly number[], pairs: readonly Pair[]): BagSolution {
	const caps = failureCaps(shape0, shape1, pairs);
	let total = Infinity;
	let splits: (readonly [number, number])[] = [];
	for (let c = 0; c <= sum(shape0); c++) {
		for (let s = 0; s <= sum(shape1); s++) {
			if (c + s > total || !caps.every(([capC, capS]) => c > capC || s > capS)) continue;
			if (c + s < total) {
				total = c + s;
				splits = [];
			}
			splits.push([c, s]);
		}
	}
	return { total, splits };
}

export type NounSpec = {
	noun: string;
	measure: string;
	hiddenLabel: string;
	hiddenValues: readonly string[];
	tactileLabel: string;
	tactileValues: readonly string[];
};

export type CandyInstance = { prompt: string; expected: readonly [total: string, tactile1: string, tactile2: string] };

export const NOUNS: readonly NounSpec[] = [
	{
		noun: "糖果",
		measure: "颗",
		hiddenLabel: "口味",
		hiddenValues: ["苹果味", "桃子味", "西瓜味", "葡萄味", "橙子味", "草莓味"],
		tactileLabel: "形状",
		tactileValues: ["圆形", "五角星形", "方形", "三角形", "心形", "月牙形"],
	},
	{
		noun: "软糖",
		measure: "颗",
		hiddenLabel: "口味",
		hiddenValues: ["苹果味", "葡萄味", "橙子味", "柠檬味", "荔枝味"],
		tactileLabel: "形状",
		tactileValues: ["圆形", "方形", "心形", "熊形"],
	},
	{
		noun: "巧克力",
		measure: "颗",
		hiddenLabel: "口味",
		hiddenValues: ["牛奶味", "黑巧味", "抹茶味", "榛子味", "草莓味"],
		tactileLabel: "形状",
		tactileValues: ["圆形", "方形", "心形", "贝壳形"],
	},
	{
		noun: "饼干",
		measure: "块",
		hiddenLabel: "馅料",
		hiddenValues: ["巧克力馅", "草莓馅", "奶油馅", "芝士馅", "抹茶馅"],
		tactileLabel: "形状",
		tactileValues: ["圆形", "方形", "心形", "星形"],
	},
	{
		noun: "水果",
		measure: "个",
		hiddenLabel: "颜色",
		hiddenValues: ["红色", "黄色", "绿色", "紫色"],
		tactileLabel: "大小",
		tactileValues: ["大个", "小个"],
	},
];

const MAX_ATTEMPTS = 1000;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

const randInt = (rand: () => number, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

type Draw = {
	spec: NounSpec;
	hidden: readonly string[];
	tactile: readonly [string, string];
	rows: readonly [readonly number[], readonly number[]];
	a: number;
	p: number;
};

function render({ spec, hidden, tactile, rows, a, p }: Draw): string {
	const { noun, measure: m, hiddenLabel: hl, tactileLabel: tl } = spec;
	const [t0, t1] = tactile;
	const item = (t: string, h: number) => `一${m}${t}${hidden[h]}${noun}`;
	return [
		`在一个黑色的袋子里放有三种${hl}的${noun}：${hidden.join("、")}。每种${hl}又各有两种${tl}：${t0}和${t1}；两种${tl}可通过手感区分，但${noun}的${hl}无法通过手感区分。`,
		"",
		`袋中${noun}数量如下：`,
		[tl, ...hidden].join("\t"),
		...tactile.map((t, i) => [t, ...rows[i]].join("\t")),
		"",
		`你需要在活动前决定从袋中摸出多少${m}${noun}，以及分别摸多少${m}${t0}、多少${m}${t1}${noun}。`,
		"",
		`要求：无论实际摸到的${hl}组合如何，手中都必须保证存在以下两种配对中的至少一种：`,
		`1. ${item(t0, a)}，和${item(t1, p)}；`,
		`2. ${item(t0, p)}，和${item(t1, a)}。`,
		"",
		`问：至少需要摸出多少${m}${noun}，才能保证满足要求？`,
		`最后一行严格按此格式写：答案：总数=?，${t0}=?，${t1}=?`,
	].join("\n");
}

export function generateCandy(seed: number): CandyInstance {
	const rand = mulberry32(seed);
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const spec = NOUNS[randInt(rand, 0, NOUNS.length - 1)];
		const hidden = shuffled(spec.hiddenValues, rand).slice(0, 3);
		const [t0, t1] = shuffled(spec.tactileValues, rand);
		const [a, p] = shuffled([0, 1, 2], rand);
		const row = () => [0, 1, 2].map(() => randInt(rand, 3, 12));
		const rows = [row(), row()] as const;
		const pairs: Pair[] = [
			[[0, a], [1, p]],
			[[0, p], [1, a]],
		];
		const { total, splits } = solveBag(rows[0], rows[1], pairs);
		if (splits.length !== 1) continue;
		const [c, s] = splits[0];
		const draw = { spec, hidden, tactile: [t0, t1] as const, rows, a, p };
		return { prompt: render(draw), expected: [String(total), String(c), String(s)] };
	}
	throw new Error(`generateCandy(${seed}): no instance with a unique split in ${MAX_ATTEMPTS} attempts`);
}

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
			const allowed = ([shape, hidden]: Cell) => ((masks[shape]! >> hidden) & 1) === 1;
			if (pairs.some(([a, b]) => allowed(a) && allowed(b))) continue;
			const cap = (shape: 0 | 1) => sum(rows[shape].filter((_, i) => ((masks[shape]! >> i) & 1) === 1));
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

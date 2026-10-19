import { describe, expect, it } from "vitest";
import { generateCandy, NOUNS, solveBag, type Pair } from "./candy-gen.ts";

const crossPairs = (a: number, p: number): Pair[] => [
	[[0, a], [1, p]],
	[[0, p], [1, a]],
];

// Every (drawn total, set of hidden values present) reachable by some draw from one shape row.
function reachable(row: readonly number[]): Set<string> {
	const out = new Set<string>();
	const visit = (i: number, drawn: number, mask: number) => {
		if (i === row.length) {
			out.add(`${drawn}:${mask}`);
			return;
		}
		for (let x = 0; x <= row[i]; x++) visit(i + 1, drawn + x, x > 0 ? mask | (1 << i) : mask);
	};
	visit(0, 0, 0);
	return out;
}

function bruteForce(shape0: number[], shape1: number[], pairs: Pair[]) {
	const draws = [reachable(shape0), reachable(shape1)].map((set) => [...set].map((k) => k.split(":").map(Number)));
	const has = (mask: number, hidden: number) => ((mask >> hidden) & 1) === 1;
	const defeated = (c: number, s: number) =>
		draws[0].some(
			([n0, m0]) =>
				n0 === c &&
				draws[1].some(
					([n1, m1]) =>
						n1 === s &&
						!pairs.some(([a, b]) => has(a[0] === 0 ? m0 : m1, a[1]) && has(b[0] === 0 ? m0 : m1, b[1])),
				),
		);
	const guaranteed: [number, number][] = [];
	for (let c = 0; c <= shape0.reduce((a, b) => a + b); c++) {
		for (let s = 0; s <= shape1.reduce((a, b) => a + b); s++) if (!defeated(c, s)) guaranteed.push([c, s]);
	}
	const total = Math.min(...guaranteed.map(([c, s]) => c + s));
	return { total, splits: guaranteed.filter(([c, s]) => c + s === total) };
}

function lcg(seed: number) {
	let state = seed;
	return (lo: number, hi: number) => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return lo + (state % (hi - lo + 1));
	};
}

describe("solveBag", () => {
	it("solves the original candy bag as 21 with the unique split 9 round + 12 star", () => {
		expect(solveBag([7, 9, 8], [7, 6, 4], crossPairs(0, 1))).toEqual({ total: 21, splits: [[9, 12]] });
	});

	it("matches a brute-force enumeration of every draw on 100 random bags", () => {
		const rand = lcg(7);
		for (let i = 0; i < 100; i++) {
			const shape0 = [rand(3, 6), rand(3, 6), rand(3, 6)];
			const shape1 = [rand(3, 6), rand(3, 6), rand(3, 6)];
			const a = rand(0, 2);
			const pairs = crossPairs(a, (a + rand(1, 2)) % 3);
			expect(solveBag(shape0, shape1, pairs), JSON.stringify({ shape0, shape1, pairs })).toEqual(
				bruteForce(shape0, shape1, pairs),
			);
		}
	});
});

// Reads the bag back out of the prompt text the way a model would, so the check does not trust generator internals.
function readPrompt(prompt: string) {
	const lines = prompt.split("\n");
	const table = lines.filter((l) => l.includes("\t")).map((l) => l.split("\t"));
	const [header, row0, row1] = table;
	const hidden = header.slice(1);
	const tactile = [row0[0], row1[0]];
	const cell = (half: string): readonly [0 | 1, number] => [
		half.includes(tactile[0]) ? 0 : 1,
		hidden.findIndex((h) => half.includes(h)),
	];
	const pairs = lines
		.filter((l) => /^[12]\. /.test(l))
		.map((l): Pair => {
			const [left, right] = l.split("，和");
			return [cell(left), cell(right)];
		});
	return { counts: [row0.slice(1).map(Number), row1.slice(1).map(Number)], tactile, pairs, lastLine: lines.at(-1) };
}

describe("generateCandy", () => {
	it("returns the same instance for the same seed and a different one for another seed", () => {
		expect(generateCandy(42)).toEqual(generateCandy(42));
		expect(generateCandy(42).prompt).not.toBe(generateCandy(43).prompt);
	});

	it("states a bag whose unique optimal split is the expected answer", () => {
		for (let seed = 0; seed < 200; seed++) {
			const { prompt, expected } = generateCandy(seed);
			const { counts, tactile, pairs, lastLine } = readPrompt(prompt);
			expect(counts.flat().filter((n) => n >= 3 && n <= 12), prompt).toHaveLength(6);
			expect(pairs.flat().map(([, h]) => h).filter((h) => h >= 0), prompt).toHaveLength(4);
			const { total, splits } = solveBag(counts[0], counts[1], pairs);
			expect(splits, prompt).toHaveLength(1);
			expect(expected).toEqual([String(total), String(splits[0][0]), String(splits[0][1])]);
			expect(lastLine).toBe(`最后一行严格按此格式写：答案：总数=?，${tactile[0]}=?，${tactile[1]}=?`);
		}
	});

	it("varies the prompt and covers every noun", () => {
		const prompts = Array.from({ length: 400 }, (_, seed) => generateCandy(seed).prompt);
		expect(new Set(prompts.slice(0, 100)).size).toBeGreaterThanOrEqual(40);
		const missing = NOUNS.filter(({ noun }) => !prompts.some((p) => p.includes(`的${noun}：`))).map((n) => n.noun);
		expect(missing).toEqual([]);
	});
});

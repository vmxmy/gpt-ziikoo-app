import { generateCandy } from "./candy-gen.ts";
import { generatePelican } from "./pelican-gen.ts";
import type { GeneratorId, Scorer } from "./types.ts";

export type GeneratedContent = { prompt: string; scorer: Scorer };

export const GENERATORS: Record<GeneratorId, (seed: number) => GeneratedContent> = {
	candy: (seed) => {
		const { prompt, expected } = generateCandy(seed);
		return { prompt, scorer: { type: "final_numbers", expected } };
	},
	pelican: (seed) => ({ prompt: generatePelican(seed), scorer: { type: "svg_animation" } }),
};
